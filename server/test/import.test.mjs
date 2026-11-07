import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { initImport, importRouter, importSource, parseCsv, parseJson } from '../src/import/bridge.mjs';
import * as store from '../src/discord/store.mjs';
import { setTransport, resetTransport } from '../src/discord/http.mjs';
const db = new DatabaseSync(':memory:'); store.initStore(db); initImport(db);
const app = importRouter(db);
const req = async (method, path, data) => {
  const r = await app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
  return { status: r.status, data: await r.json() };
};
const dir = await mkdtemp(join(tmpdir(), 'forget-import-test-'));
const json = data => strToU8(JSON.stringify(data));
const messages = cid => [0,1,2].map(i => ({ ID: `${cid}${i}`, Timestamp: '2025-01-02T12:00:00Z', Contents: `message ${i}` }));
let batchSeq = 0;
async function load(path) {
  const id = `batch-${++batchSeq}`;
  db.prepare("INSERT INTO forgetImport(id,source,status,createdAt) VALUES (?,?,'importing',?)").run(id, path, Date.now());
  await importSource(db, id, path);
  return db.prepare('SELECT * FROM forgetImport WHERE id=?').get(id);
}
try {
  assert.equal(parseJson('{"ID":1234567890123456789}').ID, '1234567890123456789');
  assert.equal(parseCsv('ID,Contents\r\n123,"hello,\n""world"""')[0].contents, 'hello,\n"world"');
  const zip = join(dir, 'export.zip');
  await writeFile(zip, zipSync({
    'messages/c100/channel.json': json({ type: 1, name: 'Alice' }),
    'messages/c100/messages.json': json([...messages('100'), { ID: 12345678901234567890, Timestamp: 'bad' }]),
    'messages/c200/channel.json': json({ type: 1, name: 'Bob' }),
    'messages/c200/messages.csv': strToU8('ID,Timestamp,Contents\n2000,2025-01-02T12:00:00Z,"hello,world"\n2001,2025-01-02T12:00:00Z,test'),
    'messages/c300/channel.json': json({ type: 0, name: 'Salon' }),
    'messages/c300/messages.json': json(messages('300')),
    '../ignored.txt': strToU8('not extracted'),
  }));
  const b = await load(zip); assert.equal(b.status, 'ready'); assert.equal(b.errors, 1);
  const status = await req('GET', '/status'); assert.equal(status.data.stats.messages, 8);
  assert.equal((await req('GET', '/channels')).data.length, 3);
  assert.equal((await req('POST', '/plan', { channelIds: [] })).status, 400);
  assert.equal((await req('POST', '/plan', { channelIds: ['100'], since: 'nonsense' })).status, 400);
  const built = await req('POST', '/plan', { channelIds: ['100', '200', '300', '100'] });
  assert.equal(built.data.count, 8); const id = built.data.planId;
  assert.equal((await req('POST', `/plan/${id}/execute`, { confirm: true })).status, 409);
  store.setToken({ token: 'mock-only', userId: '42', username: 'test' });
  assert.equal((await req('POST', `/plan/${id}/execute`, {})).status, 400);
  let now = 0, readCount = 0, deletes = 0; const inflightChannels = new Set(); let parallel = false;
  setTransport({ now: () => now, sleep: ms => new Promise(r => setImmediate(() => { now += ms; r(); })), fetchImpl: async (url, init) => {
    const u = new URL(url), cid = u.pathname.split('/')[4];
    assert(['100','200','300'].includes(cid));
    if (init.method === 'GET') {
      readCount++; inflightChannels.add(cid); parallel ||= inflightChannels.size > 1;
      await new Promise(r => setImmediate(r)); inflightChannels.delete(cid);
      const rows = cid === '200' ? messages(cid).slice(0, 2) : messages(cid);
      return new Response(JSON.stringify(rows.map(m => ({ id: m.ID, channel_id: cid, author: { id: '42' }, content: 'CURRENT ' + m.Contents, timestamp: m.Timestamp, attachments: [] }))));
    }
    assert.equal(init.method, 'DELETE');
    const mid = u.pathname.split('/').at(-1);
    const archived = db.prepare('SELECT content FROM discordArchive WHERE messageId=?').get(mid);
    assert(archived?.content.startsWith('CURRENT')); deletes++;
    return new Response(null, { status: 204 });
  } });
  assert.equal((await req('POST', `/plan/${id}/execute`, { confirm: true, concurrency: 3 })).status, 200);
  assert.equal((await req('POST', `/plan/${id}/execute`, { confirm: true })).status, 409);
  let final;
  for (let i = 0; i < 10000; i++) { final = (await req('GET', `/plan/${id}`)).data; if (final.plan.status !== 'running') break; await new Promise(r => setImmediate(r)); }
  assert.equal(final.plan.status, 'done'); assert.equal(deletes, 8); assert.equal(readCount, 3); assert(parallel);
  // Cancellation prevents the selected plan from issuing further deletes.
  const cancelPlan = (await req('POST', '/plan', { channelIds: ['100','200','300'] })).data.planId;
  await req('POST', `/plan/${cancelPlan}/execute`, { confirm: true });
  await req('POST', `/plan/${cancelPlan}/cancel`);
  for (let i = 0; i < 1000; i++) { final = (await req('GET', `/plan/${cancelPlan}`)).data; if (final.plan.status !== 'running') break; await new Promise(r => setImmediate(r)); }
  assert.equal(final.plan.status, 'cancelled'); assert.equal(deletes, 8);
  for (const foreign of [false, true]) {
    setTransport({ fetchImpl: async (_url, init) => {
      assert.equal(init.method, 'GET'); // neither missing nor foreign messages can be deleted
      return new Response(JSON.stringify(foreign ? messages('100').map(m => ({ id: m.ID, author: { id: 'someone-else' } })) : []));
    } });
    const checkId = (await req('POST', '/plan', { channelIds: ['100'] })).data.planId;
    await req('POST', `/plan/${checkId}/execute`, { confirm: true });
    for (let i = 0; i < 10000; i++) { final = (await req('GET', `/plan/${checkId}`)).data; if (final.plan.status !== 'running') break; await new Promise(r => setImmediate(r)); }
    assert.equal(final.plan.status, foreign ? 'failed' : 'done');
    assert.equal(foreign ? final.stats.failed : final.stats.skipped, 3);
    assert.equal(final.stats.deleted, 0);
  }
  const folder = join(dir, 'folder', 'messages', 'c400'); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'messages.json'), JSON.stringify(messages('400')));
  assert.equal((await load(join(dir, 'folder'))).status, 'ready');
  const engineFile = join(dir, 'engine.db'), engine = new DatabaseSync(engineFile);
  engine.exec("CREATE TABLE channel(cid TEXT,name TEXT,kind TEXT); CREATE TABLE message(mid TEXT,cid TEXT,ts INTEGER,content TEXT); INSERT INTO channel VALUES ('500','Engine','dm'); INSERT INTO message VALUES ('5001','500',1735819200,'engine message');"); engine.close();
  assert.equal((await load(engineFile)).status, 'ready');
  assert.equal((await req('GET','/status')).data.stats.messages, 1);
  console.log('PASS import: ZIP JSON/CSV, folder, SQLite, invalid rows, plan filters/dedup, confirmation, concurrent channels, page verification, archive before delete, cancellation');
} finally { resetTransport(); db.close(); await rm(dir, { recursive: true, force: true }); }
