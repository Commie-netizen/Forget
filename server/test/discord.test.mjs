// Tests du moteur Discord : aucun réseau (fetch + ws mockés, sleep instantané).
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

// ---------- mini harnais
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, msg) { if (!cond) throw new Error('assertion : ' + msg); }
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — obtenu ${JSON.stringify(a)}, attendu ${JSON.stringify(b)}`);
async function until(cond, label, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout : ' + label);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------- mocks
const calls = []; // { method, path, query, body, auth }
let handler = () => ({ status: 404, body: { message: 'non géré' } });
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
  let json = null; try { json = JSON.parse(text); } catch { /* non JSON */ }
  return { status: res.status, json, text, headers: res.headers };
};
const archiveRows = () => db.prepare('SELECT * FROM discordArchive ORDER BY rowid').all();
const resetCalls = () => { calls.length = 0; sleeps.length = 0; };
const idsAt = (ageDays, count, start = 0) =>
  Array.from({ length: count }, (_, i) => msToSnowflake(Date.now() - ageDays * DAY + (start + i) * 1000));

// ---------- tests
test('sans token : status, 409 sur les routes Discord, routes locales OK', async () => {
  let r = await req('GET', '/status');
  assert(r.status === 200 && r.json.connected === false, 'status non connecté');
  assert(r.json.disappearing && r.json.disappearing.running === false, 'disappearing dans status');
  for (const [m, p, b] of [['GET', '/me'], ['GET', '/guilds'], ['GET', '/dms'], ['GET', '/channels/c1/messages'],
    ['GET', '/search?channelId=c1'], ['POST', '/jobs/delete', { channelId: 'c1' }], ['POST', '/jobs/edit', { channelId: 'c1', edit: { mode: 'set', text: 'x' } }]]) {
    r = await req(m, p, b);
    assert(r.status === 409 && r.json.error === 'Discord non connecté', `409 attendu sur ${m} ${p} (obtenu ${r.status})`);
  }
  eq((await req('GET', '/jobs')).json, [], 'jobs vide');
  eq((await req('GET', '/archive')).json, [], 'archive vide');
  assert((await req('GET', '/disappearing')).json.enabled === false, 'disappearing off');
  assert((await req('PATCH', '/disappearing', { enabled: true })).status === 409, 'activer sans token = 409');
  assert(calls.length === 0, 'aucun appel réseau sans token');
});

test('token invalide : 401 et rien de stocké', async () => {
  handler = () => ({ status: 401, body: { message: '401: Unauthorized' } });
  const r = await req('POST', '/token', { token: 'mauvais' });
  assert(r.status === 401, 'status 401');
  assert((await req('GET', '/status')).json.connected === false, 'toujours déconnecté');
  eq(db.prepare('SELECT COUNT(*) c FROM discordToken').get().c, 0, 'aucun token en base');
  assert(calls.every((c) => c.host === 'discord.com'), 'host discord.com');
});

test('token valide : stocké, masqué, validé via /users/@me', async () => {
  resetCalls();
  handler = (c) => (c.path === '/users/@me' ? { body: ME } : { status: 404, body: {} });
  const r = await req('POST', '/token', { token: ` ${TOKEN} ` });
  assert(r.status === 200 && r.json.ok && r.json.user.id === ME.id, 'ok + user');
  eq(calls[0].auth, TOKEN, 'token (trim) envoyé à Discord');
  eq(db.prepare('SELECT token FROM discordToken WHERE id=1').get().token, TOKEN, 'token en base locale');
  const s = await req('GET', '/status');
  assert(s.json.connected && s.json.user.username === 'moi', 'connecté');
  assert(s.json.tokenMasked && !s.text.includes(TOKEN) && !r.text.includes(TOKEN), 'token jamais renvoyé');
  assert(s.json.tokenMasked.endsWith(TOKEN.slice(-4)), 'masque garde les 4 derniers caractères');
});

test('/me, /guilds, /dms, /channels/:id/messages', async () => {
  handler = (c) => {
    if (c.path === '/users/@me') return { body: ME };
    if (c.path === '/users/@me/guilds') return { body: [{ id: 'g1', name: 'Serveur', icon: null }] };
    if (c.path === '/guilds/g1/channels') return { body: [{ id: 'c1', name: 'general', type: 0, parent_id: null, position: 2 }] };
    if (c.path === '/users/@me/channels') return { body: [{ id: 'd1', type: 1, recipients: [{ id: '9', username: 'ami' }] }] };
    if (c.path === '/channels/c1/messages') return { body: [rawMsg('900000000000000001')] };
    return { status: 404, body: {} };
  };
  eq((await req('GET', '/me')).json, { user: { id: '111', username: 'moi', avatar: 'av1' }, guildsCount: 1, dmCount: 1 }, '/me');
  const g = (await req('GET', '/guilds')).json;
  eq(g[0].channels[0], { id: 'c1', name: 'general', type: 0, parentId: null, position: 2 }, 'guilds/channels');
  eq((await req('GET', '/dms')).json[0].name, 'ami', 'nom du DM');
  resetCalls();
  const m = (await req('GET', '/channels/c1/messages?before=55&limit=500')).json;
  assert(m[0].authorId === '111' && m[0].channelId === 'c1', 'messages normalisés');
  eq([calls[0].query.before, calls[0].query.limit], ['55', '100'], 'before + limit plafonné à 100');
});

// Jeu de données de recherche : 60 messages à moi, ids croissants.
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
  assert(calls[0].path === '/guilds/g1/messages/search' && calls[0].query.author_id === '111' && calls[0].query.channel_id === 'c1', 'endpoint guilde');
  r = (await req('GET', '/search?guildId=g1&offset=50')).json;
  eq([r.messages.length, r.nextOffset], [10, null], 'dernière page');
  const min = dataset[10]; // les 10 ids plus grands sont > min
  r = (await req('GET', `/search?channelId=d1&minId=${min}`)).json;
  eq(r.total, 10, 'minId filtre');
  assert(calls.at(-1).path === '/channels/d1/messages/search' && calls.at(-1).query.min_id === min, 'endpoint salon (DM) + min_id');
});

test('collectMessages : remonte jusqu\'aux plus vieux au-delà du plafond d\'offset', async () => {
  handler = (c) => searchHandler(c) ?? { status: 404, body: {} };
  resetCalls();
  const all = await collectMessages(TOKEN, { guildId: 'g1', channelId: 'c1', authorId: '111' }, { maxOffset: 25 });
  eq(all.length, 60, 'les 60 messages collectés');
  assert(BigInt(all[0].id) < BigInt(all[59].id), 'trié du plus ancien au plus récent');
  assert(calls.some((c) => c.query.max_id), 'repart avec max_id après le plafond');
  const limited = await collectMessages(TOKEN, { guildId: 'g1', authorId: '111' }, { max: 30 });
  eq(limited.length, 30, 'maxMessages respecté');
});

test('vitesses et édition pure', () => {
  eq(resolveSpeed({ mode: 'safe' }), { mode: 'safe', delayMs: 900, concurrency: 1 }, 'safe');
  eq(resolveSpeed({ mode: 'fast' }), { mode: 'fast', delayMs: 300, concurrency: 2 }, 'fast');
  eq(resolveSpeed({ mode: 'turbo' }), { mode: 'turbo', delayMs: 120, concurrency: 3 }, 'turbo');
  eq(resolveSpeed({ mode: 'custom', delayMs: 10, concurrency: 99 }), { mode: 'custom', delayMs: 150, concurrency: 4 }, 'custom clamp');
  eq(resolveSpeed({ mode: 'custom', delayMs: 700, concurrency: 0 }), { mode: 'custom', delayMs: 700, concurrency: 1 }, 'custom bas');
  eq(applyEdit('a foo b foo', { mode: 'replace', find: 'foo', replace: 'bar' }), 'a bar b bar', 'replace');
  eq(applyEdit('x', { mode: 'append', text: 'y' }) + applyEdit('x', { mode: 'prepend', text: 'y' }) + applyEdit('x', { mode: 'set', text: 'z' }), 'xyyxz', 'append/prepend/set');
});

// Handler générique de messages pour les jobs : GET around -> message, DELETE/PATCH/bulk enregistrés.
function jobHandler(extra) {
  return async (c) => {
    const around = c.path === '/channels/c1/messages' && c.query.around;
    if (around) return { body: [rawMsg(around)] };
    return (await extra?.(c)) ?? searchHandler(c) ?? { status: 204 };
  };
}

test('delete ancien : suppressions unitaires, archive avant action', async () => {
  const ids = idsAt(100, 3); // 100 jours : bulk impossible
  handler = jobHandler();
  resetCalls();
  const { json } = await req('POST', '/jobs/delete', { channelId: 'c1', messageIds: ids, speed: { mode: 'fast' } });
  assert(json.jobId, 'jobId renvoyé');
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.status, job.deleted, job.failed, job.progress, job.total], ['done', 3, 0, 3, 3], 'job terminé');
  const dels = calls.filter((c) => c.method === 'DELETE');
  eq(dels.map((c) => c.path), ids.map((id) => `/channels/c1/messages/${id}`), 'DELETE unitaires du plus ancien au plus récent');
  assert(!calls.some((c) => c.path.endsWith('bulk-delete')), 'pas de bulk pour les anciens');
  const rows = archiveRows().filter((r) => r.action === 'delete');
  eq(rows.length, 3, '3 lignes archivées');
  assert(rows[0].content.startsWith('hello foo') && rows[0].messageId === ids[0], 'contenu original conservé');
  assert(job.logs.length > 0 && job.logs[0].message.includes('démarré'), 'logs de job');
});

test('delete récent : bulk-delete par lots + reliquat unitaire', async () => {
  const recent = idsAt(1, 102); // 102 messages récents -> lots de 100 et 2
  const old = idsAt(60, 1);
  handler = jobHandler();
  resetCalls();
  const { json } = await req('POST', '/jobs/delete', { channelId: 'c1', guildId: 'g1', messageIds: [...recent, ...old] });
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.status, job.deleted], ['done', 103], 'tout supprimé');
  const bulks = calls.filter((c) => c.path === '/channels/c1/messages/bulk-delete');
  eq(bulks.map((b) => b.body.messages.length), [100, 2], 'lots de 100 puis 2');
  eq(calls.filter((c) => c.method === 'DELETE').map((c) => c.path), [`/channels/c1/messages/${old[0]}`], 'l\'ancien en unitaire');
});

test('bulk-delete refusé (403) : repli unitaire', async () => {
  const ids = idsAt(1, 3);
  handler = jobHandler((c) => (c.path.endsWith('bulk-delete') ? { status: 403, body: { message: 'Missing Permissions' } } : null));
  resetCalls();
  const { json } = await req('POST', '/jobs/delete', { channelId: 'c1', messageIds: ids });
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.status, job.deleted, job.failed], ['done', 3, 0], 'repli OK');
  eq(calls.filter((c) => c.method === 'DELETE').length, 3, '3 DELETE unitaires');
  eq(archiveRows().filter((r) => ids.includes(r.messageId)).length, 3,'pas d\'archive en double');
});

test('429 : retry_after respecté puis succès', async () => {
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
  eq([job.status, job.deleted, job.failed], ['done', 2, 0], 'job réussi malgré 429');
  assert(sleeps.reduce((a, b) => a + b, 0) >= 1500, 'sleep(1500 ms) = retry_after * 1000 (obtenu ' + JSON.stringify(sleeps) + ')');
  eq(calls.filter((c) => c.method === 'DELETE').length, 3, '1 retry sur le 1er message');
  assert(job.logs.some((l) => l.level === 'warn' && l.message.includes('429')), '429 loggé');
});

test('429 persistant : abandon après 5 retries, compté en échec', async () => {
  const ids = idsAt(90, 1);
  handler = jobHandler((c) => (c.method === 'DELETE' ? { status: 429, body: { retry_after: 0.1 } } : null));
  resetCalls();
  const { json } = await req('POST', '/jobs/delete', { channelId: 'c1', messageIds: ids });
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.deleted, job.failed], [0, 1], 'échec compté');
  eq(calls.filter((c) => c.method === 'DELETE').length, 6, '1 essai + 5 retries');
});

test('delete via recherche : parcourt mes messages (before/after), maxMessages', async () => {
  handler = jobHandler();
  resetCalls();
  const { json } = await req('POST', '/jobs/delete', { channelId: 'c1', guildId: 'g1', maxMessages: 7, before: dataset[0], method: 'search' });
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.status, job.total, job.deleted], ['done', 7, 7], '7 messages max');
  const s = calls.find((c) => c.path === '/guilds/g1/messages/search');
  assert(s.query.author_id === ME.id && s.query.max_id === dataset[0], 'recherche author_id=@me + max_id');
});

test('édition find/replace : PATCH + archive de l\'original', async () => {
  const ids = idsAt(3, 2);
  handler = jobHandler();
  resetCalls();
  const { json } = await req('POST', '/jobs/edit', { channelId: 'c1', messageIds: ids, edit: { mode: 'replace', find: 'foo', replace: 'bar' } });
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.status, job.edited, job.failed], ['done', 2, 0], 'édités');
  const patches = calls.filter((c) => c.method === 'PATCH');
  eq(patches.map((p) => p.body.content), ids.map((id) => 'hello bar ' + id), 'contenu modifié');
  const row = archiveRows().find((r) => r.action === 'edit' && r.messageId === ids[0]);
  assert(row.content === 'hello foo ' + ids[0] && JSON.parse(row.meta).newContent === 'hello bar ' + ids[0], 'original archivé');
  assert((await req('POST', '/jobs/edit', { channelId: 'c1', edit: { mode: 'replace' } })).status === 400, 'edit invalide = 400');
});

test('édition : message d\'un autre auteur ignoré', async () => {
  const ids = idsAt(3, 1, 500);
  handler = (c) => (c.query.around ? { body: [rawMsg(c.query.around, { author: { id: '999', username: 'autre' } })] } : { status: 204 });
  resetCalls();
  const { json } = await req('POST', '/jobs/edit', { channelId: 'c1', messageIds: ids, edit: { mode: 'append', text: '!' } });
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.edited, job.failed], [0, 1], 'refusé');
  assert(!calls.some((c) => c.method === 'PATCH'), 'aucun PATCH');
});

test('job annulable : progression persistée, statut cancelled', async () => {
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
  eq(job.status, 'cancelled', 'annulé');
  assert(job.cancelRequested === true, 'cancelRequested');
  assert(job.progress >= 3 && job.progress < 20 && job.total === 20, `progression partielle persistée (${job.progress}/${job.total})`);
  eq(job.deleted, job.progress, 'compteurs cohérents');
  assert((await req('POST', '/jobs/inconnu/cancel')).status === 404, 'cancel job inconnu = 404');
  assert((await req('GET', '/jobs')).json.length >= 1, 'liste des jobs');
});

test('archive : filtres, export json/csv', async () => {
  const all = (await req('GET', '/archive?limit=1000')).json;
  assert(all.length > 5 && Array.isArray(all[0].attachments), 'archive lisible');
  const q = (await req('GET', '/archive?q=hello%20foo&limit=3')).json;
  assert(q.length === 3 && q.every((r) => r.content.includes('hello foo')), 'recherche texte + limit');
  eq((await req('GET', '/archive?q=introuvable_zzz')).json, [], 'recherche sans résultat');
  eq((await req('GET', '/archive?platform=autre')).json, [], 'filtre plateforme');
  eq((await req('GET', '/archive?from=' + (Date.now() + 100000))).json, [], 'filtre from');
  const j = await req('GET', '/archive/export?format=json');
  assert(j.headers.get('content-disposition').includes('.json') && JSON.parse(j.text).length === all.length, 'export json');
  const csv = await req('GET', '/archive/export?format=csv');
  assert(csv.headers.get('content-type').startsWith('text/csv') && csv.text.split('\r\n')[0].startsWith('id,platform,action'), 'export csv');
});

test('mode disparition : gateway, suppression différée, reconnexion, arrêt', async () => {
  MockWS.instances.length = 0;
  handler = () => ({ status: 204 });
  resetCalls();
  let r = await req('PATCH', '/disappearing', { delaySec: 0 });
  assert(r.status === 400, 'delaySec invalide');
  assert((await req('PATCH', '/disappearing', { scope: 'x' })).status === 400, 'scope invalide');
  r = await req('PATCH', '/disappearing', { enabled: true, delaySec: 30, scope: 'guilds' });
  eq([r.json.enabled, r.json.running, r.json.delaySec, r.json.scope], [true, true, 30, 'guilds'], 'état après PATCH');
  await until(() => MockWS.instances.length === 1, 'connexion gateway');
  const ws = MockWS.instances[0];
  assert(ws.url.startsWith('wss://gateway.discord.gg/'), 'URL gateway');
  assert((await req('PATCH', '/disappearing', { enabled: true })).json.running, 'idempotent');
  eq(MockWS.instances.length, 1, 'pas de double gateway');

  ws.frame({ op: 10, d: { heartbeat_interval: 45000 } });
  const ident = ws.sent.find((f) => f.op === 2);
  assert(ident && ident.d.token === TOKEN, 'IDENTIFY avec le token');
  ws.frame({ op: 0, s: 1, t: 'READY', d: { user: { id: ME.id } } });
  assert((await req('GET', '/disappearing')).json.ready === true, 'READY');
  ws.frame({ op: 1 });
  assert(ws.sent.some((f) => f.op === 1 && f.d === 1), 'heartbeat sur demande avec séquence');

  const mine = rawMsg('900000000000099001', { guild_id: 'g1' });
  ws.frame({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: mine });
  ws.frame({ op: 0, s: 3, t: 'MESSAGE_CREATE', d: rawMsg('900000000000099002', { guild_id: 'g1', author: { id: '999' } }) }); // autre auteur
  ws.frame({ op: 0, s: 4, t: 'MESSAGE_CREATE', d: rawMsg('900000000000099003') }); // DM : hors scope 'guilds'
  await until(() => calls.some((c) => c.method === 'DELETE'), 'suppression programmée');
  eq(calls.filter((c) => c.method === 'DELETE').map((c) => c.path), ['/channels/c1/messages/900000000000099001'], 'seul mon message en scope supprimé');
  assert(sleeps.includes(30000), 'délai delaySec respecté');
  const row = archiveRows().find((a) => a.action === 'disappear');
  assert(row && row.messageId === '900000000000099001', 'archivé (disappear)');

  ws.close(); // coupure -> reconnexion automatique
  await until(() => MockWS.instances.length === 2, 'reconnexion');
  assert(sleeps.includes(1000), 'backoff initial 1 s');

  r = await req('PATCH', '/disappearing', { enabled: false });
  eq(r.json.running, false, 'arrêté');
  await until(() => MockWS.instances[1].closed, 'gateway fermé');
  await new Promise((res) => setTimeout(res, 30));
  eq(MockWS.instances.length, 2, 'pas de reconnexion une fois éteint');
});

test('initDiscord idempotent ; DELETE /token purge et coupe le gateway', async () => {
  MockWS.instances.length = 0;
  await req('PATCH', '/disappearing', { enabled: true });
  await until(() => MockWS.instances.length === 1, 'gateway relancé');
  initDiscord(db); initDiscord(db);
  eq(MockWS.instances.length, 1, 'initDiscord ne double pas le gateway');
  const r = await req('DELETE', '/token');
  assert(r.json.ok === true, 'ok');
  eq(db.prepare('SELECT COUNT(*) c FROM discordToken').get().c, 0, 'token purgé');
  const s = (await req('GET', '/status')).json;
  assert(s.connected === false && s.disappearing.running === false && !s.tokenMasked, 'déconnecté, gateway arrêté');
  assert((await req('GET', '/guilds')).status === 409, '409 après purge');
  assert(archiveRows().length > 0, 'archive conservée après purge du token');
});

// ---------- purges reprenables (curseur, lots, ordonnanceur)
let pool = []; // ids restants (desc)
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

test('purges : 409 sans token, puis création, validation', async () => {
  handler = () => ({ status: 404, body: {} });
  for (const [m, p, b] of [['GET', '/purges'], ['POST', '/purges', { channelId: 'c1' }], ['POST', '/purges/x/run']]) {
    assert((await req(m, p, b)).status === 409, `409 sans token sur ${m} ${p}`);
  }
  handler = (c) => (c.path === '/users/@me' ? { body: ME } : { status: 404, body: {} });
  assert((await req('POST', '/token', { token: TOKEN })).status === 200, 'reconnecté');
  assert((await req('POST', '/purges', {})).status === 400, 'channelId requis');
  assert((await req('GET', '/purges/inconnu')).status === 404, '404 purge inconnue');
});

test('purge : chunkSize, curseur persisté, nextRunAt, done, plus aucune exécution', async () => {
  loadPool(100, 130);
  const all = [...pool];
  handler = purgeHandler();
  resetCalls();
  const { json } = await req('POST', '/purges', { channelId: 'c1', channelName: 'general', chunkSize: 50, intervalSec: 60, speed: { mode: 'fast' } });
  assert(json.id, 'id renvoyé');
  await waitForPurge(json.id);
  let p = await getPurge(json.id);
  eq([p.status, p.processed, p.deleted, p.failed, p.runs], ['active', 50, 50, 0, 1], 'run 1 : exactement chunkSize');
  eq(p.cursorBefore, all[49], 'curseur = plus petit id traité (récent -> ancien)');
  assert(p.nextRunAt >= p.lastRunAt + 59000 && p.nextRunAt <= p.lastRunAt + 61000, 'nextRunAt = lastRunAt + intervalSec');
  assert(calls.filter((c) => c.path.endsWith('/messages/search')).every((c) => !c.query.offset || c.query.offset === '0'), 'jamais d\'offset croissant (pas de collecte globale)');
  assert(calls.filter((c) => c.method === 'DELETE').length === 50, '50 DELETE unitaires (anciens)');
  eq(archiveRows().filter((r) => r.meta && r.meta.includes(json.id)).length, 50, 'archive avant suppression');

  assert((await req('POST', `/purges/${json.id}/run`)).json.ok === true, 'run manuel');
  await waitForPurge(json.id);
  p = await getPurge(json.id);
  eq([p.status, p.processed, p.runs], ['active', 100, 2], 'run 2');
  eq(p.cursorBefore, all[99], 'curseur avancé');

  await req('POST', `/purges/${json.id}/run`);
  await waitForPurge(json.id);
  p = await getPurge(json.id);
  eq([p.status, p.processed, p.deleted, p.runs, p.nextRunAt], ['done', 130, 130, 3, null], 'run 3 : épuisé -> done');
  eq(pool.length, 0, 'tout supprimé côté Discord');
  assert((await req('POST', `/purges/${json.id}/run`)).status === 409, 'plus d\'exécution une fois done');
  eq(tickPurges(Date.now() + 1e9), [], 'ordonnanceur ignore une purge done');
  assert((await req('GET', '/purges')).json.some((x) => x.id === json.id), 'listée');
});

test('purge récente : bulk-delete par page, reprise après redémarrage via ordonnanceur', async () => {
  loadPool(1, 60);
  const all = [...pool];
  handler = purgeHandler();
  resetCalls();
  const { json } = await req('POST', '/purges', { channelId: 'c1', guildId: 'g1', chunkSize: 25, intervalSec: 1 });
  await waitForPurge(json.id);
  let p = await getPurge(json.id);
  eq([p.processed, p.status, p.cursorBefore], [25, 'active', all[24]], 'premier lot + curseur');
  eq(calls.filter((c) => c.path.endsWith('bulk-delete')).map((c) => c.body.messages.length), [25], 'bulk <14 j');
  assert(calls.some((c) => c.path === '/guilds/g1/messages/search'), 'recherche de guilde');

  // redémarrage : on rouvre le module sur la même base ; seul le curseur en base sert
  stopDiscord();
  initDiscord(db);
  resetCalls();
  assert(tickPurges(p.nextRunAt - 1000).length === 0, 'pas encore échu');
  const due = tickPurges(p.nextRunAt + 1);
  eq(due, [json.id], 'ordonnanceur déclenche la purge échue');
  await waitForPurge(json.id);
  const first = calls.find((c) => c.path.endsWith('/messages/search'));
  eq(first.query.max_id, all[24], 'reprise au curseur persisté');
  p = await getPurge(json.id);
  eq([p.status, p.deleted, p.runs], ['active', 50, 2], 'lot 2 (25) puis chunk atteint');
  await req('POST', `/purges/${json.id}/run`);
  await waitForPurge(json.id);
  p = await getPurge(json.id);
  eq([p.status, p.deleted], ['done', 60], 'terminé');
});

test('purge : annulation (DELETE) en cours de run et avant run', async () => {
  loadPool(100, 40);
  let dels = 0;
  handler = purgeHandler((c) => {
    if (c.method === 'DELETE' && ++dels === 3) db.prepare("UPDATE discordPurge SET status='cancelled'").run(); // annulation concurrente
    return null;
  });
  resetCalls();
  const { json } = await req('POST', '/purges', { channelId: 'c1', chunkSize: 1000, speed: { mode: 'fast' } });
  await waitForPurge(json.id);
  const p = await getPurge(json.id);
  eq(p.status, 'cancelled', 'reste cancelled');
  assert(p.deleted >= 3 && p.deleted < 40, `arrêt en cours de page (${p.deleted}/40)`);
  assert((await req('POST', `/purges/${json.id}/run`)).status === 409, 'run refusé si cancelled');

  loadPool(100, 10);
  handler = purgeHandler();
  const b = (await req('POST', '/purges', { channelId: 'c1' })).json.id;
  assert((await req('DELETE', '/purges/' + b)).json.ok === true, 'DELETE ok');
  await waitForPurge(b);
  eq((await getPurge(b)).status, 'cancelled', 'annulée avant exécution');
  eq(pool.length, 10, 'rien supprimé');
  assert((await req('DELETE', '/purges/inconnu')).status === 404, '404 inconnue');
});

test('purge : erreur 401 -> status error, run manuel réactive', async () => {
  loadPool(100, 5);
  handler = purgeHandler((c) => (c.path.endsWith('/messages/search') ? { status: 401, body: { message: '401: Unauthorized' } } : null));
  const { json } = await req('POST', '/purges', { channelId: 'c1' });
  await waitForPurge(json.id);
  let p = await getPurge(json.id);
  assert(p.status === 'error' && /Unauthorized/.test(p.error) && p.nextRunAt === null, 'error + message');
  handler = purgeHandler();
  assert((await req('POST', `/purges/${json.id}/run`)).json.ok, 'run relance');
  await waitForPurge(json.id);
  p = await getPurge(json.id);
  eq([p.status, p.deleted], ['done', 5], 'terminé après relance');
});

// ---------- exécution
let pass = 0;
for (const t of tests) {
  try { await t.fn(); pass++; console.log('  ok   ' + t.name); } catch (e) { console.log('  FAIL ' + t.name + '\n       ' + e.message); }
}
stopDiscord();
resetTransport();
console.log(`${pass === tests.length ? 'PASS' : 'FAIL'} ${pass}/${tests.length}`);
process.exit(pass === tests.length ? 0 : 1);
