// Tests V5 : connexion intégrée (hook), chiffrement du token, jobs actifs, méthode historique 100/page, présets.
// Aucun réseau : fetch mocké, sleep instantané.
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { initDiscord, discordRouter, stopDiscord, setTransport, resetTransport, waitForJob, securityInfo } from '../src/discord/index.mjs';
import * as store from '../src/discord/store.mjs';
import { resolveSpeed } from '../src/discord/bulk.mjs';
import { msToSnowflake, cmpId } from '../src/discord/util.mjs';

const TOKEN = 'SECRET.TOKEN.VALUE-abcd1234';
const ME = { id: '111', username: 'moi', avatar: 'av1' };
const OTHER = { id: '999', username: 'autre' };
const DAY = 24 * 3600 * 1000;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, msg) { if (!cond) throw new Error('assertion : ' + msg); }
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — obtenu ${JSON.stringify(a)}, attendu ${JSON.stringify(b)}`);

const calls = [];
let handler = () => ({ status: 404, body: {} });
function mockFetch(url, init) {
  const u = new URL(url);
  const call = {
    method: init.method, path: u.pathname.replace('/api/v10', ''), query: Object.fromEntries(u.searchParams),
    body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization,
  };
  calls.push(call);
  return Promise.resolve(handler(call)).then((r) => {
    const status = r.status ?? 200;
    return new Response(status === 204 || r.body === undefined ? null : JSON.stringify(r.body), { status });
  });
}

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE IF NOT EXISTS setting(key TEXT PRIMARY KEY, value TEXT)');
let virtualNow = 0;
setTransport({ fetchImpl: mockFetch, now: () => virtualNow, sleep: (ms) => { virtualNow += ms; return new Promise(r => setImmediate(r)); } });
initDiscord(db);
const app = new Hono();
app.route('/api/discord', discordRouter());
const req = async (method, path, body) => {
  const res = await app.request('/api/discord' + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non JSON */ }
  return { status: res.status, json, text };
};
const rawRow = () => db.prepare('SELECT token FROM discordToken WHERE id=1').get()?.token;
const meOk = (c) => (c.path === '/users/@me' ? { body: ME } : null);

// ---------- C1 : login-window
test('login-window : 501 sans hook (JSON)', async () => {
  delete globalThis.__FORGET_LOGIN_WINDOW;
  const r = await req('POST', '/login-window');
  assert(r.status === 501 && /bureau/.test(r.json.error), '501 + message');
  eq(calls.length, 0, 'aucun appel réseau');
});

test('login-window : 200 avec hook mocké (validation /users/@me + stockage)', async () => {
  globalThis.__FORGET_LOGIN_WINDOW = async () => ({ token: ` ${TOKEN} ` });
  handler = (c) => meOk(c) ?? { status: 404, body: {} };
  const r = await req('POST', '/login-window');
  assert(r.status === 200 && r.json.ok && r.json.user.id === ME.id, 'ok + user');
  assert(!r.text.includes(TOKEN), 'token jamais renvoyé');
  eq(calls.find((c) => c.path === '/users/@me').auth, TOKEN, 'token validé via /users/@me');
  eq(rawRow(), TOKEN, 'stocké (en clair : pas de cipher)');
});

test('login-window : 400 annulé, 401 refusé par Discord, 500 erreur du hook', async () => {
  globalThis.__FORGET_LOGIN_WINDOW = async () => ({ cancelled: true });
  let r = await req('POST', '/login-window');
  assert(r.status === 400 && r.json.cancelled === true, '400 annulé');
  globalThis.__FORGET_LOGIN_WINDOW = async () => ({ token: 'mauvais' });
  handler = () => ({ status: 401, body: { message: '401: Unauthorized' } });
  r = await req('POST', '/login-window');
  assert(r.status === 401, '401 token refusé');
  eq(rawRow(), TOKEN, 'ancien token intact');
  globalThis.__FORGET_LOGIN_WINDOW = async () => ({ error: 'boom' });
  r = await req('POST', '/login-window');
  assert(r.status === 500 && r.json.error === 'boom', 'erreur du hook');
  delete globalThis.__FORGET_LOGIN_WINDOW;
});

// ---------- C2 : chiffrement
const mockCipher = {
  encrypt: (s) => Buffer.from('X' + [...s].reverse().join('')).toString('base64'),
  decrypt: (b) => [...Buffer.from(b, 'base64').toString().slice(1)].reverse().join(''),
};

test('securité : plain sans cipher', () => {
  delete globalThis.__FORGET_CIPHER;
  eq(securityInfo(), { tokenEncrypted: false, cipher: 'plain', archivePlaintext: true }, '/api/security sans cipher');
});

test('cipher : lecture d\'une ligne en clair puis ré-écriture chiffrée', () => {
  assert(rawRow() === TOKEN, 'ligne en clair au départ');
  globalThis.__FORGET_CIPHER = mockCipher;
  eq(store.getToken().token, TOKEN, 'lecture rétro-compatible du clair');
  assert(rawRow().startsWith('enc:v1:') && !rawRow().includes(TOKEN), 'ré-écrit chiffré à la première lecture');
  eq(store.getToken().token, TOKEN, 'round-trip déchiffré');
  eq(securityInfo(), { tokenEncrypted: true, cipher: 'dpapi', archivePlaintext: true }, '/api/security avec cipher');
});

test('cipher : setToken chiffre, base = enc:v1:<base64>, API ne fuit pas le token', async () => {
  globalThis.__FORGET_CIPHER = mockCipher;
  store.setToken({ token: 'AUTRE.TOKEN', userId: '111', username: 'moi', avatar: null });
  const raw = rawRow();
  assert(raw === 'enc:v1:' + mockCipher.encrypt('AUTRE.TOKEN'), 'format enc:v1: + base64');
  eq(store.getToken().token, 'AUTRE.TOKEN', 'round-trip');
  const s = await req('GET', '/status');
  assert(s.json.connected && !s.text.includes('AUTRE.TOKEN') && s.json.tokenMasked.endsWith('OKEN'), 'status masqué');
});

test('cipher : chiffré mais cipher absent ou invalide -> non connecté (sans écraser)', () => {
  const raw = rawRow();
  delete globalThis.__FORGET_CIPHER;
  eq(store.getToken(), null, 'illisible sans cipher');
  eq(rawRow(), raw, 'ligne intacte');
  globalThis.__FORGET_CIPHER = { encrypt: mockCipher.encrypt, decrypt: () => { throw new Error('autre machine'); } };
  eq(store.getToken(), null, 'decrypt en échec -> null');
  globalThis.__FORGET_CIPHER = mockCipher;
  store.setToken({ token: TOKEN, userId: ME.id, username: ME.username, avatar: null }); // état propre pour la suite
});

// ---------- présets
test('présets : safe 900/1, fast 300/2, turbo 120/3', () => {
  eq(resolveSpeed({ mode: 'safe' }), { mode: 'safe', delayMs: 900, concurrency: 1 }, 'safe');
  eq(resolveSpeed({ mode: 'fast' }), { mode: 'fast', delayMs: 300, concurrency: 2 }, 'fast');
  eq(resolveSpeed({ mode: 'turbo' }), { mode: 'turbo', delayMs: 120, concurrency: 3 }, 'turbo');
  eq(resolveSpeed({}), { mode: 'safe', delayMs: 900, concurrency: 1 }, 'défaut = safe');
});

// ---------- C4 : historique
let channels = {}; // channelId -> messages bruts (desc)
const del = (cid, ids) => { channels[cid] = channels[cid].filter((m) => !ids.includes(m.id)); };
let inflight = 0, maxInflight = 0;
const historyHandler = (extra) => async (c) => {
  const r = await extra?.(c);
  if (r) return r;
  let m = c.path.match(/^\/channels\/(\w+)\/messages$/);
  if (m && c.method === 'GET') {
    const lim = Number(c.query.limit), before = c.query.before;
    const list = channels[m[1]];
    if (!list) return { status: 403, body: { message: 'Missing Access' } };
    return { body: list.filter((x) => !before || cmpId(x.id, before) < 0).slice(0, lim) };
  }
  if (c.path.endsWith('/bulk-delete')) { del(c.path.split('/')[2], c.body.messages); return { status: 204 }; }
  m = c.path.match(/^\/channels\/(\w+)\/messages\/(\d+)$/);
  if (m && c.method === 'DELETE') {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 3));
    inflight--;
    del(m[1], [m[2]]);
    return { status: 204 };
  }
  return { status: 404, body: {} };
};
const mk = (cid, ageMs, i, author = ME, extra = {}) => {
  const id = msToSnowflake(Date.now() - ageMs + i * 1000);
  return { id, channel_id: cid, author, content: 'msg ' + id, timestamp: new Date(Date.now() - ageMs + i * 1000).toISOString(), attachments: [], ...extra };
};
// 250 messages : 100 anciens (60 j), 150 récents (1 j) ; 1 sur 5 d'un autre auteur ; 1 message système (type 7) à moi.
function buildChannel(cid) {
  const list = [];
  for (let i = 0; i < 100; i++) list.push(mk(cid, 60 * DAY, i, i % 5 === 4 ? OTHER : ME));
  for (let i = 0; i < 150; i++) list.push(mk(cid, DAY, i, i % 5 === 4 ? OTHER : ME, i === 10 ? { type: 1 } : {}));
  channels[cid] = list.reverse();
}
const historyGets = (cid) => calls.filter((c) => c.method === 'GET' && c.path === `/channels/${cid}/messages`);

test('historique : scope all = pages de 100 (before), filtre auteur, bulk + unitaire, curseur', async () => {
  buildChannel('c1');
  const oldest = channels.c1.at(-1).id;
  const mine = channels.c1.filter((m) => m.author.id === ME.id && !m.type);
  const others = channels.c1.filter((m) => m.author.id !== ME.id || m.type);
  calls.length = 0; handler = historyHandler();
  const { json } = await req('POST', '/jobs/delete', { channelId: 'c1', channelName: 'general', speed: { mode: 'fast' } });
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.status, job.deleted, job.failed, job.total, job.progress], ['done', mine.length, 0, mine.length, mine.length], 'job terminé');
  const gets = historyGets('c1');
  eq(gets.map((g) => g.query.limit), ['100', '100', '100'], '250 messages = 3 pages de 100 (pas de page vide : 3e page < 100)');
  assert(gets.every((g) => !g.path.includes('search')), 'aucune recherche');
  assert(gets[0].query.before === undefined, '1re page sans before');
  assert(cmpId(gets[1].query.before, gets[2].query.before) > 0, 'before décroît de page en page');
  const cur = JSON.parse(db.prepare('SELECT cursor FROM discordJob WHERE id=?').get(json.jobId).cursor);
  eq([cur.channelId, cur.before], ['c1', oldest], 'curseur persisté = plus ancien id parcouru');
  assert(!calls.some((c) => c.path.endsWith('/messages/search')), 'pas d\'appel search');
  // seuls mes messages supprimés ; les autres + le message système restent
  eq(channels.c1.map((m) => m.id).sort(), others.map((m) => m.id).sort(), 'messages d\'autrui et système préservés');
  assert(calls.filter((c) => c.path.endsWith('/bulk-delete')).every((c) => c.body.messages.length <= 100 && c.body.messages.length >= 2), 'bulk par lots <= 100');
  assert(calls.some((c) => c.path.endsWith('/bulk-delete')), 'bulk utilisé pour les récents');
  assert(calls.filter((c) => c.method === 'DELETE').length === mine.filter((m) => Date.now() - Date.parse(m.timestamp) > 14 * DAY).length, 'unitaire pour les > 14 j');
  assert(job.logs.some((l) => l.message.includes('historique')), 'log méthode historique');
});

test('historique : borne de dates (after/before) et arrêt dès la borne dépassée', async () => {
  buildChannel('c2');
  const lower = msToSnowflake(Date.now() - 10 * DAY); // exclut les anciens
  calls.length = 0; handler = historyHandler();
  const { json } = await req('POST', '/jobs/delete', { channelId: 'c2', after: lower, before: new Date(Date.now() - DAY + 100 * 1000).toISOString() });
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  const oldMine = channels.c2.filter((m) => cmpId(m.id, lower) < 0 && m.author.id === ME.id).length;
  assert(oldMine === 80, 'les 80 anciens à moi intacts');
  assert(job.status === 'done' && job.deleted > 0 && job.deleted < 150 * 0.8, 'seuls les récents dans la fenêtre supprimés');
  const first = historyGets('c2')[0];
  assert(first.query.before && cmpId(first.query.before, msToSnowflake(Date.now() - DAY)) > 0, 'before initial = borne haute');
  eq(historyGets('c2').length, 2, '2 pages seulement : arrêt dès que la page franchit la borne basse');
});

test('historique : maxMessages respecté, annulation sans avancer le curseur', async () => {
  buildChannel('c3');
  calls.length = 0; handler = historyHandler();
  let { json } = await req('POST', '/jobs/delete', { channelId: 'c3', maxMessages: 30 });
  await waitForJob(json.jobId);
  eq((await req('GET', '/jobs/' + json.jobId)).json.deleted, 30, 'maxMessages = 30');

  buildChannel('c4');
  const oldest4 = channels.c4.at(-1).id;
  let n = 0, jobId = null;
  handler = historyHandler(async (c) => { if (c.method === 'DELETE' && ++n === 2) await req('POST', `/jobs/${jobId}/cancel`); return null; });
  jobId = (await req('POST', '/jobs/delete', { channelId: 'c4' })).json.jobId;
  await waitForJob(jobId);
  const job = (await req('GET', '/jobs/' + jobId)).json;
  assert(job.status === 'cancelled' && job.deleted < 200, 'annulé en cours de page');
  const cur = JSON.parse(db.prepare('SELECT cursor FROM discordJob WHERE id=?').get(jobId).cursor);
  assert(cmpId(cur.before, oldest4) > 0, 'curseur non avancé au-delà de la page interrompue (elle serait revue)');
});

test('historique : guild-wide = liste des salons texte puis salon par salon (séquentiel), 403 ignoré', async () => {
  for (const c of ['t1', 't2']) buildChannel(c);
  const total = ['t1', 't2'].reduce((a, c) => a + channels[c].filter((m) => m.author.id === ME.id && !m.type).length, 0);
  calls.length = 0;
  handler = historyHandler((c) => (c.path === '/guilds/g9/channels'
    ? { body: [{ id: 't2', name: 'b', type: 0, position: 2 }, { id: 'v1', name: 'vocal', type: 2, position: 0 }, { id: 't1', name: 'a', type: 0, position: 1 }, { id: 'priv', name: 'secret', type: 0, position: 3 }] }
    : null));
  const { json } = await req('POST', '/jobs/delete', { guildId: 'g9', speed: { mode: 'turbo' } });
  assert(json.jobId, 'guildId seul accepté');
  await waitForJob(json.jobId);
  const job = (await req('GET', '/jobs/' + json.jobId)).json;
  eq([job.status, job.deleted], ['done', total], 'tout supprimé sur 2 salons');
  const order = calls.filter((c) => c.method === 'GET' && c.path.endsWith('/messages')).map((c) => c.path.split('/')[2]);
  eq([...new Set(order)], ['t1', 't2', 'priv'], 'ordre par position, salon vocal ignoré');
  assert(order.lastIndexOf('t1') < order.indexOf('t2'), 'séquentiel : t1 terminé avant t2');
  assert(job.logs.some((l) => l.level === 'warn' && l.message.includes('secret')), '403 loggé et ignoré');
  assert((await req('POST', '/jobs/delete', {})).status === 400, 'ni channelId ni guildId = 400');
});

test('historique : un seul DELETE en vol par quota de salon, même en turbo', async () => {
  buildChannel('c5');
  // on ne garde que des anciens pour forcer l'unitaire
  channels.c5 = channels.c5.filter((m) => Date.now() - Date.parse(m.timestamp) > 14 * DAY);
  inflight = 0; maxInflight = 0; calls.length = 0; handler = historyHandler();
  const { json } = await req('POST', '/jobs/delete', { channelId: 'c5', speed: { mode: 'turbo' } });
  await waitForJob(json.jobId);
  eq(maxInflight, 1, 'quota de salon partagé entre les lanes');
  inflight = 0; maxInflight = 0; buildChannel('c6');
  channels.c6 = channels.c6.filter((m) => Date.now() - Date.parse(m.timestamp) > 14 * DAY);
  await waitForJob((await req('POST', '/jobs/delete', { channelId: 'c6', speed: { mode: 'safe' } })).json.jobId);
  eq(maxInflight, 1, 'safe = 1 à la fois');
});

test('méthode : contenu ou method:search -> recherche conservée', async () => {
  buildChannel('c7');
  calls.length = 0;
  handler = historyHandler((c) => (c.path.endsWith('/messages/search') ? { body: { total_results: 0, messages: [] } } : null));
  const a = (await req('POST', '/jobs/delete', { channelId: 'c7', guildId: 'g1', content: 'foo' })).json.jobId;
  await waitForJob(a);
  const s = calls.find((c) => c.path === '/guilds/g1/messages/search');
  assert(s && s.query.content === 'foo' && s.query.author_id === ME.id, 'recherche avec content + author_id');
  assert(historyGets('c7').length === 0, 'aucune pagination d\'historique');
});

// ---------- C3 : jobs actifs
test('jobs/active : queued/running avec progression, vide ensuite', async () => {
  buildChannel('c8');
  let release; const gate = new Promise((r) => { release = r; });
  let started; const startedP = new Promise((r) => { started = r; });
  handler = historyHandler(async (c) => { if (c.method === 'GET' && c.path === '/channels/c8/messages') { started(); await gate; } return null; });
  const { json } = await req('POST', '/jobs/delete', { channelId: 'c8' });
  await startedP;
  const r = await req('GET', '/jobs/active');
  assert(r.status === 200 && r.json.running === 1 && r.json.jobs.length === 1, 'un job actif');
  const j = r.json.jobs[0];
  eq(Object.keys(j).sort(), ['deleted', 'edited', 'failed', 'id', 'kind', 'progress', 'startedAt', 'status', 'total'], 'champs du contrat');
  assert(j.id === json.jobId && j.kind === 'delete' && j.status === 'running' && typeof j.startedAt === 'number', 'valeurs');
  release();
  await waitForJob(json.jobId);
  eq((await req('GET', '/jobs/active')).json, { jobs: [], running: 0 }, 'plus rien d\'actif');
});

test('jobs/active : accessible sans token (lecture locale)', async () => {
  await req('DELETE', '/token');
  const r = await req('GET', '/jobs/active');
  assert(r.status === 200 && r.json.running === 0, '200 sans connexion');
});

let pass = 0;
for (const t of tests) {
  try { await t.fn(); pass++; console.log('  ok   ' + t.name); } catch (e) { console.log('  FAIL ' + t.name + '\n       ' + e.message); }
}
stopDiscord();
resetTransport();
console.log(`${pass === tests.length ? 'PASS' : 'FAIL'} ${pass}/${tests.length}`);
process.exit(pass === tests.length ? 0 : 1);
