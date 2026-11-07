// Discord engine tests: no network (mocked fetch and ws, instant sleep).
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import { initDiscord, discordRouter, stopDiscord, setTransport, resetTransport, waitForJob, waitForPurge, tickPurges } from '../src/discord/index.mjs';
import { collectMessages } from '../src/discord/search.mjs';
import { resolveSpeed, applyEdit } from '../src/discord/bulk.mjs';
import { msToSnowflake } from '../src/discord/util.mjs';

const TOKEN = 'SECRET.TOKEN.VALUE-abcd1234';
const ME = { id: '111', username: 'moi', avatar: 'av1' };
const DAY = 24 * 3600 * 1000;

// ---------- minimal harness
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, msg) { if (!cond) throw new Error('assertion : ' + msg); }
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
async function until(cond, label, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout : ' + label);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------- mocks
const calls = []; // { method, path, query, body, auth }
let handler = () => ({ status: 404, body: { message: 'not handled' } });
const sleeps = [];
let virtualNow = 0;

function mockFetch(url, init) {
  const u = new URL(url);
  const call = {
    method: init.method, path: u.pathname.replace('/api/v10', ''), query: Object.fromEntries(u.searchParams),
    body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization, host: u.host,
  };
  calls.push(call);
  return Promise.resolve(handler(call)).then((r) => {
    const status = r.status ?? 200;
    return new Response(status === 204 || r.body === undefined ? null : JSON.stringify(r.body), { status });
  });
}

class MockWS extends EventEmitter {
  static instances = [];
  constructor(url) {
    super();
    this.url = url; this.sent = []; this.closed = false;
    MockWS.instances.push(this);
  }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { if (!this.closed) { this.closed = true; setImmediate(() => this.emit('close')); } }
  terminate() { this.close(); }
  frame(f) { this.emit('message', JSON.stringify(f)); }
}

const rawMsg = (id, extra = {}) => ({
  id, channel_id: 'c1', author: { id: ME.id, username: ME.username }, content: 'hello foo ' + id,
  timestamp: new Date(Number((BigInt(id) >> 22n)) + 1420070400000).toISOString(), attachments: [], ...extra,
});

// ---------- setup
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE IF NOT EXISTS setting(key TEXT PRIMARY KEY, value TEXT)');
setTransport({ fetchImpl: mockFetch, wsImpl: MockWS, now: () => virtualNow, sleep: (ms) => { sleeps.push(ms); virtualNow += ms; return new Promise(r => setImmediate(r)); } });
initDiscord(db);
const app = new Hono();
app.route('/api/discord', discordRouter());
const req = async (method, path, body) => {
  const res = await app.request('/api/discord' + path, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /*non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
};
const archiveRows = () => db.prepare('SELECT * FROM discordArchive ORDER BY rowid').all();
const resetCalls = () => { calls.length = 0; sleeps.length = 0; };
const idsAt = (ageDays, count, start = 0) =>
  Array.from({ length: count }, (_, i) => msToSnowflake(Date.now() - ageDays * DAY + (start + i) * 1000));

// ---------- tests
test('without token: status, 409 on Discord routes, local routes OK', async () => {
  let r = await req('GET', '/status');
  assert(r.status === 200 && r.json.connected === false, 'status not connected');
  assert(r.json.disappearing && r.json.disappearing.running === false, 'disappearing in status');
  for (const [m, p, b] of [['GET', '/me'], ['GET', '/guilds'], ['GET', '/dms'], ['GET', '/channels/c1/messages'],
    ['GET', '/search?channelId=c1'], ['POST', '/jobs/delete', { channelId: 'c1' }], ['POST', '/jobs/edit', { channelId: 'c1', edit: { mode: 'set', text: 'x' } }]]) {
    r = await req(m, p, b);
    assert(r.status === 409 && r.json.error === 'Discord is not connected', `409 expected on ${m} ${p} (got ${r.status})`);
  }
  eq((await req('GET', '/jobs')).json, [], 'empty jobs');
  eq((await req('GET', '/archive')).json, [], 'empty archive');
  assert((await req('GET', '/disappearing')).json.enabled === false, 'disappearing off');
  assert((await req('PATCH', '/disappearing', { enabled: true })).status === 409, 'enable without token = 409');
  assert(calls.length === 0, 'no network call without token');
});

test('invalid token: 401 and nothing stored', async () => {
  handler = () => ({ status: 401, body: { message: '401: Unauthorized' } });
  const r = await req('POST', '/token', { token: 'mauvais' });
  assert(r.status === 401, 'status 401');
  assert((await req('GET', '/status')).json.connected === false, 'still disconnected');
  eq(db.prepare('SELECT COUNT(*) c FROM discordToken').get().c, 0, 'no token in the database');
  assert(calls.every((c) => c.host === 'discord.com'), 'host discord.com');
});

test('valid token: stored, masked, validated via /users/@me', async () => {
  resetCalls();
  handler = (c) => (c.path === '/users/@me' ? { body: ME } : { status: 404, body: {} });
  const r = await req('POST', '/token', { token: ` ${TOKEN} ` });
  assert(r.status === 200 && r.json.ok && r.json.user.id === ME.id, 'ok + user');
  eq(calls[0].auth, TOKEN, 'token (trimmed) sent to Discord');
  eq(db.prepare('SELECT token FROM discordToken WHERE id=1').get().token, TOKEN, 'token in local database');
  const s = await req('GET', '/status');
  assert(s.json.connected && s.json.user.username === 'moi', 'connected');
  assert(s.json.tokenMasked && !s.text.includes(TOKEN) && !r.text.includes(TOKEN), 'token never returned');
  assert(s.json.tokenMasked.endsWith(TOKEN.slice(-4)), 'mask keeps the last 4 characters');
});

test('/me, /guilds, /dms, /channels/:id/messages', async () => {
  handler = (c) => {
    if (c.path === '/users/@me') return { body: ME };
    if (c.path === '/users/@me/guilds') return { body: [{ id: 'g1', name: 'Server', icon: null }] };
    if (c.path === '/guilds/g1/channels') return { body: [{ id: 'c1', name: 'general', type: 0, parent_id: null, position: 2 }] };
    if (c.path === '/users/@me/channels') return { body: [{ id: 'd1', type: 1, recipients: [{ id: '9', username: 'friend' }] }] };
    if (c.path === '/channels/c1/messages') return { body: [rawMsg('900000000000000001')] };
    return { status: 404, body: {} };
  };
  eq((await req('GET', '/me')).json, { user: { id: '111', username: 'moi', avatar: 'av1' }, guildsCount: 1, dmCount: 1 }, '/me');
  const g = (await req('GET', '/guilds')).json;
  eq(g[0].channels[0], { id: 'c1', name: 'general', type: 0, parentId: null, position: 2 }, 'guilds/channels');
  eq((await req('GET', '/dms')).json[0].name, 'friend', 'DM name');
  resetCalls();
  const m = (await req('GET', '/channels/c1/messages?before=55&limit=500')).json;
  assert(m[0].authorId === '111' && m[0].channelId === 'c1', 'normalized messages');
  eq([calls[0].query.before, calls[0].query.limit], ['55', '100'], 'before + limit capped at 100');
});

// Search dataset: 60 messages by me, ascending IDs.
const dataset = Array.from({ length: 60 }, (_, i) => String(900000000000000100n + BigInt(i) * 1000n)).reverse(); // desc
function searchHandler(c) {
  if (!c.path.endsWith('/messages/search')) return null;
  const q = c.query;
  let ids = dataset.filter((id) => (!q.min_id || BigInt(id) > BigInt(q.min_id)) && (!q.max_id || BigInt(id) < BigInt(q.max_id)));
  const total = ids.length;
  ids = ids.slice(Number(q.offset || 0), Number(q.offset || 0) + 25);
  return { body: { total_results: total, messages: ids.map((id) => [rawMsg(id, { hit: true })]) } };
}

test('/search : pagination offset + minId', async () => {
  handler = (c) => searchHandler(c) ?? { status: 404, body: {} };
  resetCalls();
  let r = (await req('GET', '/search?guildId=g1&channelId=c1&authorId=111&offset=0')).json;
  eq([r.total, r.messages.length, r.nextOffset], [60, 25, 25], 'page 1');
  assert(calls[0].path === '/guilds/g1/messages/search' && calls[0].query.author_id === '111' && calls[0].query.channel_id === 'c1', 'guild endpoint');
  r = (await req('GET', '/search?guildId=g1&offset=50')).json;
  eq([r.messages.length, r.nextOffset], [10, null], 'last page');
  const min = dataset[10]; // the 10 higher IDs are > min
  r = (await req('GET', `/search?channelId=d1&minId=${min}`)).json;
  eq(r.total, 10, 'minId filters');
  assert(calls.at(-1).path === '/channels/d1/messages/search' && calls.at(-1).query.min_id === min, 'channel endpoint (DM) + min_id');
});

test('collectMessages: goes back to the oldest beyond the offset cap', async () => {
  handler = (c) => searchHandler(c) ?? { status: 404, body: {} };
  resetCalls();
  const all = await collectMessages(TOKEN, { guildId: 'g1', channelId: 'c1', authorId: '111' }, { maxOffset: 25 });
  eq(all.length, 60, 'all 60 messages collected');
  assert(BigInt(all[0].id) < BigInt(all[59].id), 'sorted from oldest to newest');
  assert(calls.some((c) => c.query.max_id), 'restarts with max_id after the cap');
  const limited = await collectMessages(TOKEN, { guildId: 'g1', authorId: '111' }, { max: 30 });
  eq(limited.length, 30, 'maxMessages respected');
});

test('speeds and pure edit', () => {
  eq(resolveSpeed({ mode: 'safe' }), { mode: 'safe', delayMs: 900, concurrency: 1 }, 'safe');
  eq(resolveSpeed({ mode: 'fast' }), { mode: 'fast', delayMs: 300, concurrency: 2 }, 'fast');
  eq(resolveSpeed({ mode: 'turbo' }), { mode: 'turbo', delayMs: 120, concurrency: 3 }, 'turbo');
  eq(resolveSpeed({ mode: 'custom', delayMs: 10, concurrency: 99 }), { mode: 'custom', delayMs: 150, concurrency: 4 }, 'custom clamp');
  eq(resolveSpeed({ mode: 'custom', delayMs: 700, concurrency: 0 }), { mode: 'custom', delayMs: 700, concurrency: 1 }, 'custom low');
  eq(applyEdit('a foo b foo', { mode: 'replace', find: 'foo', replace: 'bar' }), 'a bar b bar', 'replace');
  eq(applyEdit('x', { mode: 'append', text: 'y' }) + applyEdit('x', { mode: 'prepend', text: 'y' }) + applyEdit('x', { mode: 'set', text: 'z' }), 'xyyxz', 'append/prepend/set');
});

// Generic message handler for jobs: GET around -> message; record DELETE/PATCH/bulk.
function jobHandler(extra) {
  return async (c) => {
    const around = c.path === '/channels/c1/messages' && c.query.around;
    if (around) return { body: [rawMsg(around)] };
    return (await extra?.(c)) ?? searchHandler(c) ?? { status: 204 };
  };
}

test('old delete: single deletes, archive before action', async () => {
  const ids = idsAt(100, 3); // 100 days: bulk deletion unavailable
  handler = jobHandler();
  resetCalls();
  const { json } = await req('POST', '/jobs/delete', { channelId: 'c1', messageIds: ids, speed: { mode: 'fast' } });
  assert(json.jobId, 'jobId returned');
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.status, job.deleted, job.failed, job.progress, job.total], ['done', 3, 0, 3, 3], 'job finished');
  const dels = calls.filter((c) => c.method === 'DELETE');
  eq(dels.map((c) => c.path), ids.map((id) => `/channels/c1/messages/${id}`), 'single DELETEs from oldest to newest');
  assert(!calls.some((c) => c.path.endsWith('bulk-delete')), 'no bulk for old messages');
  const rows = archiveRows().filter((r) => r.action === 'delete');
  eq(rows.length, 3, '3 rows archived');
  assert(rows[0].content.startsWith('hello foo') && rows[0].messageId === ids[0], 'original content kept');
  assert(job.logs.length > 0 && job.logs[0].message.includes('started'), 'job logs');
});

test('recent delete: bulk-delete in batches + single remainder', async () => {
  const recent = idsAt(1, 102); // 102 recent messages -> batches of 100 and 2
  const old = idsAt(60, 1);
  handler = jobHandler();
  resetCalls();
  const { json } = await req('POST', '/jobs/delete', { channelId: 'c1', guildId: 'g1', messageIds: [...recent, ...old] });
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.status, job.deleted], ['done', 103], 'everything deleted');
  const bulks = calls.filter((c) => c.path === '/channels/c1/messages/bulk-delete');
  eq(bulks.map((b) => b.body.messages.length), [100, 2], 'batches of 100 then 2');
  eq(calls.filter((c) => c.method === 'DELETE').map((c) => c.path), [`/channels/c1/messages/${old[0]}`], 'l\'ancien en unitaire');
});

test('bulk-delete refused (403): single-delete fallback', async () => {
  const ids = idsAt(1, 3);
  handler = jobHandler((c) => (c.path.endsWith('bulk-delete') ? { status: 403, body: { message: 'Missing Permissions' } } : null));
  resetCalls();
  const { json } = await req('POST', '/jobs/delete', { channelId: 'c1', messageIds: ids });
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.status, job.deleted, job.failed], ['done', 3, 0], 'fallback OK');
  eq(calls.filter((c) => c.method === 'DELETE').length, 3, '3 single DELETEs');
  eq(archiveRows().filter((r) => ids.includes(r.messageId)).length, 3,'no duplicate archive');
});

test('429: retry_after respected then success', async () => {
  const ids = idsAt(90, 2);
  let hits = 0;
  handler = jobHandler((c) => {
    if (c.method === 'DELETE' && hits++ === 0) return { status: 429, body: { message: 'rate limited', retry_after: 1.5, global: false } };
    return null;
  });
  resetCalls();
  const { json } = await req('POST', '/jobs/delete', { channelId: 'c1', messageIds: ids, speed: { mode: 'custom', delayMs: 150, concurrency: 1 } });
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.status, job.deleted, job.failed], ['done', 2, 0], 'job succeeded despite 429');
  assert(sleeps.reduce((a, b) => a + b, 0) >= 1500, 'sleep(1500 ms) = retry_after * 1000 (got ' + JSON.stringify(sleeps) + ')');
  eq(calls.filter((c) => c.method === 'DELETE').length, 3, '1 retry on the first message');
  assert(job.logs.some((l) => l.level === 'warn' && l.message.includes('429')), '429 logged');
});

test('persistent 429: give up after 5 retries, counted as failed', async () => {
  const ids = idsAt(90, 1);
  handler = jobHandler((c) => (c.method === 'DELETE' ? { status: 429, body: { retry_after: 0.1 } } : null));
  resetCalls();
  const { json } = await req('POST', '/jobs/delete', { channelId: 'c1', messageIds: ids });
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.deleted, job.failed], [0, 1], 'failure counted');
  eq(calls.filter((c) => c.method === 'DELETE').length, 6, '1 attempt + 5 retries');
});

test('delete via search: walks my messages (before/after), maxMessages', async () => {
  handler = jobHandler();
  resetCalls();
  const { json } = await req('POST', '/jobs/delete', { channelId: 'c1', guildId: 'g1', maxMessages: 7, before: dataset[0], method: 'search' });
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.status, job.total, job.deleted], ['done', 7, 7], '7 messages max');
  const s = calls.find((c) => c.path === '/guilds/g1/messages/search');
  assert(s.query.author_id === ME.id && s.query.max_id === dataset[0], 'search author_id=@me + max_id');
});

test('find/replace edit: PATCH + archive of the original', async () => {
  const ids = idsAt(3, 2);
  handler = jobHandler();
  resetCalls();
  const { json } = await req('POST', '/jobs/edit', { channelId: 'c1', messageIds: ids, edit: { mode: 'replace', find: 'foo', replace: 'bar' } });
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.status, job.edited, job.failed], ['done', 2, 0], 'edited');
  const patches = calls.filter((c) => c.method === 'PATCH');
  eq(patches.map((p) => p.body.content), ids.map((id) => 'hello bar ' + id), 'content changed');
  const row = archiveRows().find((r) => r.action === 'edit' && r.messageId === ids[0]);
  assert(row.content === 'hello foo ' + ids[0] && JSON.parse(row.meta).newContent === 'hello bar ' + ids[0], 'original archived');
  assert((await req('POST', '/jobs/edit', { channelId: 'c1', edit: { mode: 'replace' } })).status === 400, 'invalid edit = 400');
});

test('edit: message from another author skipped', async () => {
  const ids = idsAt(3, 1, 500);
  handler = (c) => (c.query.around ? { body: [rawMsg(c.query.around, { author: { id: '999', username: 'other' } })] } : { status: 204 });
  resetCalls();
  const { json } = await req('POST', '/jobs/edit', { channelId: 'c1', messageIds: ids, edit: { mode: 'append', text: '!' } });
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.edited, job.failed], [0, 1], 'refused');
  assert(!calls.some((c) => c.method === 'PATCH'), 'no PATCH');
});

test('cancellable job: progress persisted, status cancelled', async () => {
  const ids = idsAt(80, 20);
  let jobId = null, dels = 0;
  handler = jobHandler(async (c) => {
    if (c.method === 'DELETE' && ++dels === 3) await req('POST', `/jobs/${jobId}/cancel`);
    return null;
  });
  resetCalls();
  jobId = (await req('POST', '/jobs/delete', { channelId: 'c1', messageIds: ids })).json.jobId;
  await waitForJob(jobId);
  const job = (await req('GET', '/jobs/' + jobId)).json;
  eq(job.status, 'cancelled', 'cancelled');
  assert(job.cancelRequested === true, 'cancelRequested');
  assert(job.progress >= 3 && job.progress < 20 && job.total === 20, `partial progress persisted (${job.progress}/${job.total})`);
  eq(job.deleted, job.progress, 'consistent counters');
  assert((await req('POST', '/jobs/unknown/cancel')).status === 404, 'cancel unknown job = 404');
  assert((await req('GET', '/jobs')).json.length >= 1, 'job list');
});

test('archive: filters, json/csv export', async () => {
  const all = (await req('GET', '/archive?limit=1000')).json;
  assert(all.length > 5 && Array.isArray(all[0].attachments), 'archive readable');
  const q = (await req('GET', '/archive?q=hello%20foo&limit=3')).json;
  assert(q.length === 3 && q.every((r) => r.content.includes('hello foo')), 'text search + limit');
  eq((await req('GET', '/archive?q=notfound_zzz')).json, [], 'search with no result');
  eq((await req('GET', '/archive?platform=other')).json, [], 'platform filter');
  eq((await req('GET', '/archive?from=' + (Date.now() + 100000))).json, [], 'from filter');
  const j = await req('GET', '/archive/export?format=json');
  assert(j.headers.get('content-disposition').includes('.json') && JSON.parse(j.text).length === all.length, 'export json');
  const csv = await req('GET', '/archive/export?format=csv');
  assert(csv.headers.get('content-type').startsWith('text/csv') && csv.text.split('\r\n')[0].startsWith('id,platform,action'), 'export csv');
});

test('disappearing mode: gateway, delayed delete, reconnect, stop', async () => {
  MockWS.instances.length = 0;
  handler = () => ({ status: 204 });
  resetCalls();
  let r = await req('PATCH', '/disappearing', { delaySec: 0 });
  assert(r.status === 400, 'invalid delaySec');
  assert((await req('PATCH', '/disappearing', { scope: 'x' })).status === 400, 'invalid scope');
  r = await req('PATCH', '/disappearing', { enabled: true, delaySec: 30, scope: 'guilds' });
  eq([r.json.enabled, r.json.running, r.json.delaySec, r.json.scope], [true, true, 30, 'guilds'], 'state after PATCH');
  await until(() => MockWS.instances.length === 1, 'gateway connection');
  const ws = MockWS.instances[0];
  assert(ws.url.startsWith('wss://gateway.discord.gg/'), 'URL gateway');
  assert((await req('PATCH', '/disappearing', { enabled: true })).json.running, 'idempotent');
  eq(MockWS.instances.length, 1, 'no double gateway');

  ws.frame({ op: 10, d: { heartbeat_interval: 45000 } });
  const ident = ws.sent.find((f) => f.op === 2);
  assert(ident && ident.d.token === TOKEN, 'IDENTIFY with the token');
  ws.frame({ op: 0, s: 1, t: 'READY', d: { user: { id: ME.id } } });
  assert((await req('GET', '/disappearing')).json.ready === true, 'READY');
  ws.frame({ op: 1 });
  assert(ws.sent.some((f) => f.op === 1 && f.d === 1), 'heartbeat on request with sequence');

  const mine = rawMsg('900000000000099001', { guild_id: 'g1' });
  ws.frame({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: mine });
  ws.frame({ op: 0, s: 3, t: 'MESSAGE_CREATE', d: rawMsg('900000000000099002', { guild_id: 'g1', author: { id: '999' } }) }); // another author
  ws.frame({ op: 0, s: 4, t: 'MESSAGE_CREATE', d: rawMsg('900000000000099003') }); // DM: outside scope 'guilds'
  await until(() => calls.some((c) => c.method === 'DELETE'), 'scheduled delete');
  eq(calls.filter((c) => c.method === 'DELETE').map((c) => c.path), ['/channels/c1/messages/900000000000099001'], 'only my in-scope message deleted');
  assert(sleeps.includes(30000), 'delaySec respected');
  const row = archiveRows().find((a) => a.action === 'disappear');
  assert(row && row.messageId === '900000000000099001', 'archived (disappear)');

  ws.close(); // disconnect -> automatic reconnection
  await until(() => MockWS.instances.length === 2, 'reconnect');
  assert(sleeps.includes(1000), 'initial backoff 1 s');

  r = await req('PATCH', '/disappearing', { enabled: false });
  eq(r.json.running, false, 'stopped');
  await until(() => MockWS.instances[1].closed, 'gateway closed');
  await new Promise((res) => setTimeout(res, 30));
  eq(MockWS.instances.length, 2, 'no reconnect once turned off');
});

test('initDiscord idempotent; DELETE /token purges and stops the gateway', async () => {
  MockWS.instances.length = 0;
  await req('PATCH', '/disappearing', { enabled: true });
  await until(() => MockWS.instances.length === 1, 'gateway restarted');
  initDiscord(db); initDiscord(db);
  eq(MockWS.instances.length, 1, 'initDiscord does not duplicate the gateway');
  const r = await req('DELETE', '/token');
  assert(r.json.ok === true, 'ok');
  eq(db.prepare('SELECT COUNT(*) c FROM discordToken').get().c, 0, 'token purged');
  const s = (await req('GET', '/status')).json;
  assert(s.connected === false && s.disappearing.running === false && !s.tokenMasked, 'disconnected, gateway stopped');
  assert((await req('GET', '/guilds')).status === 409, '409 after purge');
  assert(archiveRows().length > 0, 'archive kept after token purge');
});

// ---------- resumable purges (cursor, batches, scheduler)
let pool = []; // remaining IDs (descending)
const purgeHandler = (extra) => (c) => {
  const r = extra?.(c);
  if (r) return r;
  if (c.path.endsWith('/messages/search')) {
    const ids = pool.filter((id) => !c.query.max_id || BigInt(id) < BigInt(c.query.max_id));
    return { body: { total_results: ids.length, messages: ids.slice(Number(c.query.offset || 0), Number(c.query.offset || 0) + 25).map((id) => [rawMsg(id, { hit: true })]) } };
  }
  if (c.method === 'DELETE') { pool = pool.filter((id) => !c.path.endsWith('/' + id)); return { status: 204 }; }
  if (c.path.endsWith('bulk-delete')) { pool = pool.filter((id) => !c.body.messages.includes(id)); return { status: 204 }; }
  return { status: 404, body: {} };
};
const getPurge = async (id) => (await req('GET', '/purges/' + id)).json;
const loadPool = (ageDays, n) => { pool = idsAt(ageDays, n).reverse(); };

test('purges: 409 without token, then creation, validation', async () => {
  handler = () => ({ status: 404, body: {} });
  for (const [m, p, b] of [['GET', '/purges'], ['POST', '/purges', { channelId: 'c1' }], ['POST', '/purges/x/run']]) {
    assert((await req(m, p, b)).status === 409, `409 without token on ${m} ${p}`);
  }
  handler = (c) => (c.path === '/users/@me' ? { body: ME } : { status: 404, body: {} });
  assert((await req('POST', '/token', { token: TOKEN })).status === 200, 'reconnected');
  assert((await req('POST', '/purges', {})).status === 400, 'channelId required');
  assert((await req('GET', '/purges/unknown')).status === 404, '404 unknown purge');
});

test('purge: chunkSize, persisted cursor, nextRunAt, done, no further run', async () => {
  loadPool(100, 130);
  const all = [...pool];
  handler = purgeHandler();
  resetCalls();
  const { json } = await req('POST', '/purges', { channelId: 'c1', channelName: 'general', chunkSize: 50, intervalSec: 60, speed: { mode: 'fast' } });
  assert(json.id, 'id returned');
  await waitForPurge(json.id);
  let p = await getPurge(json.id);
  eq([p.status, p.processed, p.deleted, p.failed, p.runs], ['active', 50, 50, 0, 1], 'run 1: exactly chunkSize');
  eq(p.cursorBefore, all[49], 'cursor = smallest processed id (recent -> old)');
  assert(p.nextRunAt >= p.lastRunAt + 59000 && p.nextRunAt <= p.lastRunAt + 61000, 'nextRunAt = lastRunAt + intervalSec');
  assert(calls.filter((c) => c.path.endsWith('/messages/search')).every((c) => !c.query.offset || c.query.offset === '0'), 'never an increasing offset (no global collection)');
  assert(calls.filter((c) => c.method === 'DELETE').length === 50, '50 single DELETEs (old)');
  eq(archiveRows().filter((r) => r.meta && r.meta.includes(json.id)).length, 50, 'archive before delete');

  assert((await req('POST', `/purges/${json.id}/run`)).json.ok === true, 'manual run');
  await waitForPurge(json.id);
  p = await getPurge(json.id);
  eq([p.status, p.processed, p.runs], ['active', 100, 2], 'run 2');
  eq(p.cursorBefore, all[99], 'cursor advanced');

  await req('POST', `/purges/${json.id}/run`);
  await waitForPurge(json.id);
  p = await getPurge(json.id);
  eq([p.status, p.processed, p.deleted, p.runs, p.nextRunAt], ['done', 130, 130, 3, null], 'run 3: exhausted -> done');
  eq(pool.length, 0, 'everything deleted on Discord');
  assert((await req('POST', `/purges/${json.id}/run`)).status === 409, 'no more runs once done');
  eq(tickPurges(Date.now() + 1e9), [], 'scheduler ignores a done purge');
  assert((await req('GET', '/purges')).json.some((x) => x.id === json.id), 'listed');
});

test('recent purge: bulk-delete per page, resume after restart via scheduler', async () => {
  loadPool(1, 60);
  const all = [...pool];
  handler = purgeHandler();
  resetCalls();
  const { json } = await req('POST', '/purges', { channelId: 'c1', guildId: 'g1', chunkSize: 25, intervalSec: 1 });
  await waitForPurge(json.id);
  let p = await getPurge(json.id);
  eq([p.processed, p.status, p.cursorBefore], [25, 'active', all[24]], 'first batch + cursor');
  eq(calls.filter((c) => c.path.endsWith('bulk-delete')).map((c) => c.body.messages.length), [25], 'bulk < 14 days');
  assert(calls.some((c) => c.path === '/guilds/g1/messages/search'), 'guild search');

  // restart: reopen the module on the same database; only the persisted cursor is used
  stopDiscord();
  initDiscord(db);
  resetCalls();
  assert(tickPurges(p.nextRunAt - 1000).length === 0, 'not due yet');
  const due = tickPurges(p.nextRunAt + 1);
  eq(due, [json.id], 'scheduler triggers the due purge');
  await waitForPurge(json.id);
  const first = calls.find((c) => c.path.endsWith('/messages/search'));
  eq(first.query.max_id, all[24], 'resumes at the persisted cursor');
  p = await getPurge(json.id);
  eq([p.status, p.deleted, p.runs], ['active', 50, 2], 'batch 2 (25) then chunk reached');
  await req('POST', `/purges/${json.id}/run`);
  await waitForPurge(json.id);
  p = await getPurge(json.id);
  eq([p.status, p.deleted], ['done', 60], 'finished');
});

test('purge: cancel (DELETE) during a run and before a run', async () => {
  loadPool(100, 40);
  let dels = 0;
  handler = purgeHandler((c) => {
    if (c.method === 'DELETE' && ++dels === 3) db.prepare("UPDATE discordPurge SET status='cancelled'").run(); // concurrent cancellation
    return null;
  });
  resetCalls();
  const { json } = await req('POST', '/purges', { channelId: 'c1', chunkSize: 1000, speed: { mode: 'fast' } });
  await waitForPurge(json.id);
  const p = await getPurge(json.id);
  eq(p.status, 'cancelled', 'stays cancelled');
  assert(p.deleted >= 3 && p.deleted < 40, `stopped mid-page (${p.deleted}/40)`);
  assert((await req('POST', `/purges/${json.id}/run`)).status === 409, 'run refused when cancelled');

  loadPool(100, 10);
  handler = purgeHandler();
  const b = (await req('POST', '/purges', { channelId: 'c1' })).json.id;
  assert((await req('DELETE', '/purges/' + b)).json.ok === true, 'DELETE ok');
  await waitForPurge(b);
  eq((await getPurge(b)).status, 'cancelled', 'cancelled before running');
  eq(pool.length, 10, 'nothing deleted');
  assert((await req('DELETE', '/purges/unknown')).status === 404, '404 unknown');
});

test('purge: 401 error -> status error, manual run reactivates', async () => {
  loadPool(100, 5);
  handler = purgeHandler((c) => (c.path.endsWith('/messages/search') ? { status: 401, body: { message: '401: Unauthorized' } } : null));
  const { json } = await req('POST', '/purges', { channelId: 'c1' });
  await waitForPurge(json.id);
  let p = await getPurge(json.id);
  assert(p.status === 'error' && /Unauthorized/.test(p.error) && p.nextRunAt === null, 'error + message');
  handler = purgeHandler();
  assert((await req('POST', `/purges/${json.id}/run`)).json.ok, 'run restarted');
  await waitForPurge(json.id);
  p = await getPurge(json.id);
  eq([p.status, p.deleted], ['done', 5], 'finished after restart');
});

// ---------- execution
let pass = 0;
for (const t of tests) {
  try { await t.fn(); pass++; console.log('  ok   ' + t.name); } catch (e) { console.log('  FAIL ' + t.name + '\n       ' + e.message); }
}
stopDiscord();
resetTransport();
console.log(`${pass === tests.length ? 'PASS' : 'FAIL'} ${pass}/${tests.length}`);
process.exit(pass === tests.length ? 0 : 1);
