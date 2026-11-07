// Forget 4.3 : mise à jour GitHub, OAuth X/Reddit (PKCE, refresh), TikTok reposts, protections Discord, réglages réservés.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initStore } from '../src/discord/store.mjs';
import { updateRouter, compareVersions, hashFor } from '../src/update/index.mjs';
import { socialRouter } from '../src/social/index.mjs';
import { tiktokRouter } from '../src/social/tiktok.mjs';
import { protectionFilter, protectionParams } from '../src/discord/util.mjs';

let pass = 0;
const results = [];
async function check(name, fn) {
  console.error(`... ${name}`);
  try { await fn(); pass++; results.push(`  ok   ${name}`); } catch (e) { results.push(`  FAIL ${name}\n       ${e.stack || e.message}`); }
}
const json = (data, init = {}) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' }, ...init });
const call = async (app, method, path, body) => {
  const r = await app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
};
const newDb = () => { const db = new DatabaseSync(':memory:'); initStore(db); return db; };
const online = (db) => db.prepare("INSERT OR REPLACE INTO setting VALUES ('privacy.offline','false')").run();
const until = async (fn, n = 20000) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setImmediate(r)); } throw new Error('timeout'); };

// ---------- Mises à jour ----------
await check('versions : comparaison x.y.z et pré-versions', () => {
  assert.equal(compareVersions('4.3.0', '4.2.9'), 1);
  assert.equal(compareVersions('v4.3.0', '4.3.0'), 0);
  assert.equal(compareVersions('4.3.0-beta.1', '4.3.0'), -1);
  assert.equal(compareVersions('4.10.0', '4.9.9'), 1);
  assert.throws(() => compareVersions('abc', '1.0.0'));
});
await check('SHA256SUMS : extraction par nom de fichier', () => {
  const h = 'a'.repeat(64);
  assert.equal(hashFor(`${'b'.repeat(64)}  autre.exe\n${h} *Forget-4.4.0.exe\n`, 'Forget-4.4.0.exe'), h);
  assert.equal(hashFor('pas de hash', 'x.exe'), null);
});

const installer = Buffer.from('MZ fake installer bytes '.repeat(1000));
const goodHash = createHash('sha256').update(installer).digest('hex');
function githubMock({ sums = `${goodHash}  Forget-4.4.0.exe\n`, evilRedirect = false, tag = 'v4.4.0' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url); calls.push(u.hostname + u.pathname);
    assert.equal(init.redirect, 'manual');
    if (u.hostname === 'api.github.com' && u.pathname === '/repos/me/forget/releases/latest') {
      return json({ tag_name: tag, name: `Forget ${tag}`, body: 'Notes', html_url: 'https://github.com/me/forget/releases/tag/' + tag, published_at: '2026-11-07T00:00:00Z',
        assets: [
          { name: 'Forget-4.4.0.exe', size: installer.length, browser_download_url: 'https://github.com/me/forget/releases/download/v4.4.0/Forget-4.4.0.exe' },
          { name: 'SHA256SUMS.txt', size: 100, browser_download_url: 'https://github.com/me/forget/releases/download/v4.4.0/SHA256SUMS.txt' },
        ] });
    }
    if (u.hostname === 'github.com' && u.pathname.endsWith('.exe')) {
      return new Response(null, { status: 302, headers: { location: evilRedirect ? 'https://evil.example.com/x.exe' : 'https://release-assets.githubusercontent.com/a/setup' } });
    }
    if (u.hostname === 'github.com' && u.pathname.endsWith('SHA256SUMS.txt')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/a/sums' } });
    if (u.hostname === 'release-assets.githubusercontent.com' && u.pathname === '/a/sums') return new Response(sums);
    if (u.hostname === 'release-assets.githubusercontent.com' && u.pathname === '/a/setup') return new Response(installer, { headers: { 'content-length': String(installer.length) } });
    throw new Error('appel inattendu ' + url);
  };
  return { fetchImpl, calls };
}

await check('update : dépôt non configuré -> 409, format de dépôt validé', async () => {
  const db = newDb();
  const app = updateRouter(db, { fetchImpl: async () => { throw new Error('aucun appel attendu'); }, currentVersion: '4.3.0' });
  assert.equal((await call(app, 'POST', '/check')).status, 409);
  assert.equal((await call(app, 'PUT', '/repo', { repo: 'pas un dépôt' })).status, 400);
  assert.equal((await call(app, 'PUT', '/repo', { repo: 'https://github.com/me/forget.git' })).data.repo, 'me/forget');
});

await check('update : vérification, téléchargement suivi, SHA-256 vérifié, installeur confié à Electron', async () => {
  const db = newDb(), dir = mkdtempSync(join(tmpdir(), 'forget-upd-'));
  const { fetchImpl, calls } = githubMock();
  let installed = null;
  globalThis.__FORGET_INSTALL_UPDATE = async (f) => { installed = f; };
  try {
    const app = updateRouter(db, { fetchImpl, downloadDir: dir, currentVersion: '4.3.0' });
    await call(app, 'PUT', '/repo', { repo: 'me/forget' });
    assert.equal((await call(app, 'POST', '/install')).status, 409); // pas encore vérifié
    const r = await call(app, 'POST', '/check');
    assert.equal(r.status, 200);
    assert.equal(r.data.available, true); assert.equal(r.data.latest, '4.4.0'); assert.equal(r.data.installable, true);
    assert.equal((await call(app, 'POST', '/install')).data.started, true);
    await until(() => installed);
    assert.equal(readFileSync(installed).length, installer.length);
    assert.equal((await call(app, 'GET', '/')).data.state.phase, 'installing');
    assert(calls.includes('release-assets.githubusercontent.com/a/setup'));
  } finally { delete globalThis.__FORGET_INSTALL_UPDATE; rmSync(dir, { recursive: true, force: true }); }
});

await check('update : somme différente -> fichier supprimé, rien d’installé', async () => {
  const db = newDb(), dir = mkdtempSync(join(tmpdir(), 'forget-upd-'));
  const { fetchImpl } = githubMock({ sums: `${'0'.repeat(64)}  Forget-4.4.0.exe\n` });
  let installed = false;
  globalThis.__FORGET_INSTALL_UPDATE = async () => { installed = true; };
  try {
    const app = updateRouter(db, { fetchImpl, downloadDir: dir, currentVersion: '4.3.0' });
    await call(app, 'PUT', '/repo', { repo: 'me/forget' });
    await call(app, 'POST', '/check');
    await call(app, 'POST', '/install');
    const st = await until(async () => { const s = (await call(app, 'GET', '/')).data.state; return s.phase === 'error' && s; });
    assert.match(st.error, /SHA-256/);
    assert.equal(installed, false);
    assert.equal(existsSync(join(dir, 'Forget-4.4.0.exe')), false);
  } finally { delete globalThis.__FORGET_INSTALL_UPDATE; rmSync(dir, { recursive: true, force: true }); }
});

await check('update : redirection vers un hôte non autorisé refusée ; déjà à jour', async () => {
  const db = newDb(), dir = mkdtempSync(join(tmpdir(), 'forget-upd-'));
  globalThis.__FORGET_INSTALL_UPDATE = async () => { throw new Error('ne doit pas être appelé'); };
  try {
    const { fetchImpl } = githubMock({ evilRedirect: true });
    const app = updateRouter(db, { fetchImpl, downloadDir: dir, currentVersion: '4.3.0' });
    await call(app, 'PUT', '/repo', { repo: 'me/forget' });
    await call(app, 'POST', '/check'); await call(app, 'POST', '/install');
    const st = await until(async () => { const s = (await call(app, 'GET', '/')).data.state; return s.phase === 'error' && s; });
    assert.match(st.error, /evil\.example\.com/);
    const same = updateRouter(db, { fetchImpl: githubMock({ tag: 'v4.3.0' }).fetchImpl, downloadDir: dir, currentVersion: '4.3.0' });
    const r = await call(same, 'POST', '/check');
    assert.equal(r.data.available, false);
    assert.equal((await call(same, 'POST', '/install')).status, 409);
  } finally { delete globalThis.__FORGET_INSTALL_UPDATE; rmSync(dir, { recursive: true, force: true }); }
});

// ---------- OAuth X / Reddit ----------
function oauthMock(now) {
  const seen = { token: [], api: [] };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/2/oauth2/token' || u.pathname === '/api/v1/access_token') {
      const form = Object.fromEntries(new URLSearchParams(init.body));
      seen.token.push({ host: u.hostname, form, auth: init.headers.Authorization || null });
      if (form.code === 'bad') return json({ error: 'invalid_grant' }, { status: 400 });
      const n = seen.token.length;
      return json({ access_token: `ACCESS${n}`, refresh_token: form.grant_type === 'refresh_token' && u.hostname === 'www.reddit.com' ? undefined : `REFRESH${n}`, expires_in: 7200 });
    }
    seen.api.push({ path: u.pathname, auth: init.headers.Authorization });
    if (u.pathname === '/2/users/me') return json({ data: { id: '42', username: 'alice' } });
    if (u.pathname === '/api/v1/me') return json({ id: '42', name: 'alice' });
    if (u.pathname === '/2/users/42/tweets') return json({ data: [], meta: {} });
    throw new Error('appel inattendu ' + url);
  };
  return { fetchImpl, seen };
}

await check('OAuth X : PKCE S256, state vérifié, jeton chiffré, renouvellement automatique', async () => {
  const db = newDb(); online(db);
  let t = Date.now();
  const { fetchImpl, seen } = oauthMock();
  globalThis.__FORGET_CIPHER = { encrypt: (s) => 'c:' + s, decrypt: (s) => s.slice(2) };
  let lastAuth = null;
  globalThis.__FORGET_OAUTH_WINDOW = async ({ authorizeUrl, redirectUri }) => {
    lastAuth = new URL(authorizeUrl);
    return { url: `${redirectUri}?state=${lastAuth.searchParams.get('state')}&code=GOOD` };
  };
  try {
    const app = socialRouter(db, { fetchImpl, now: () => t, sleep: async () => {} });
    assert.equal((await call(app, 'POST', '/twitter/oauth', { clientId: 'x', redirectUri: 'http://127.0.0.1:53682/cb' })).status, 400); // client id trop court
    assert.equal((await call(app, 'POST', '/twitter/oauth', { clientId: 'myclient', redirectUri: 'http://evil.example.com/cb' })).status, 400);
    const r = await call(app, 'POST', '/twitter/oauth', { clientId: 'myclient', redirectUri: 'http://127.0.0.1:53682/forget/callback' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.connected, true); assert.equal(r.data.oauth.renewable, true);
    assert.equal(lastAuth.origin + lastAuth.pathname, 'https://x.com/i/oauth2/authorize');
    assert.equal(lastAuth.searchParams.get('code_challenge_method'), 'S256');
    assert.match(lastAuth.searchParams.get('scope'), /offline\.access/);
    const ex = seen.token[0];
    assert.equal(ex.host, 'api.x.com'); assert.equal(ex.form.grant_type, 'authorization_code'); assert.equal(ex.form.client_id, 'myclient');
    assert.equal(createHash('sha256').update(ex.form.code_verifier).digest('base64url'), lastAuth.searchParams.get('code_challenge'));
    const secret = db.prepare("SELECT secret FROM socialAccount WHERE provider='twitter'").get().secret;
    assert(secret.startsWith('c:{') && !JSON.stringify(r.data).includes('ACCESS1'));
    // 2 h plus tard : renouvellement avant l'appel API.
    t += 7200 * 1000;
    assert.equal((await call(app, 'GET', '/twitter/posts')).status, 200);
    assert.equal(seen.token[1].form.grant_type, 'refresh_token'); assert.equal(seen.token[1].form.refresh_token, 'REFRESH1');
    assert.equal(seen.api.at(-1).auth, 'Bearer ACCESS2');
    // state falsifié
    globalThis.__FORGET_OAUTH_WINDOW = async ({ redirectUri }) => ({ url: `${redirectUri}?state=forged&code=GOOD` });
    assert.equal((await call(app, 'POST', '/twitter/oauth', { clientId: 'myclient', redirectUri: 'http://127.0.0.1:53682/cb' })).status, 400);
  } finally { delete globalThis.__FORGET_OAUTH_WINDOW; delete globalThis.__FORGET_CIPHER; }
});

await check('OAuth Reddit : application installée (Basic client_id:), durée permanente, refus et hors-ligne', async () => {
  const db = newDb();
  const { fetchImpl, seen } = oauthMock();
  let auth = null;
  globalThis.__FORGET_OAUTH_WINDOW = async ({ authorizeUrl, redirectUri }) => { auth = new URL(authorizeUrl); return { url: `${redirectUri}?state=${auth.searchParams.get('state')}&code=${globalThis.__code}` }; };
  try {
    const app = socialRouter(db, { fetchImpl, sleep: async () => {} });
    assert.equal((await call(app, 'POST', '/reddit/oauth', { clientId: 'redditapp', redirectUri: 'http://127.0.0.1:53682/cb' })).status, 409); // hors-ligne
    online(db);
    globalThis.__code = 'bad';
    assert.equal((await call(app, 'POST', '/reddit/oauth', { clientId: 'redditapp', redirectUri: 'http://127.0.0.1:53682/cb' })).status, 401);
    globalThis.__code = 'GOOD';
    const r = await call(app, 'POST', '/reddit/oauth', { clientId: 'redditapp', redirectUri: 'http://127.0.0.1:53682/cb' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(auth.searchParams.get('duration'), 'permanent');
    assert.equal(auth.origin + auth.pathname, 'https://www.reddit.com/api/v1/authorize');
    const ex = seen.token.at(-1);
    assert.equal(ex.host, 'www.reddit.com'); assert.equal(ex.auth, 'Basic ' + Buffer.from('redditapp:').toString('base64'));
    assert.equal(ex.form.code_verifier, undefined);
    assert.equal((await call(app, 'GET', '/reddit/status')).data.persistence, 'session'); // pas de chiffrement : mémoire seule
  } finally { delete globalThis.__FORGET_OAUTH_WINDOW; delete globalThis.__code; }
});

// ---------- TikTok ----------
function fakeTikTok({ pages = 2, refuseRemovals = 0 } = {}) {
  const log = [];
  let refusals = refuseRemovals;
  const items = Array.from({ length: pages * 3 }, (_, i) => ({ id: String(7000000000000000000n + BigInt(i)), desc: i % 2 ? `danse #fun ${i}` : `recette ${i}`, author: i < 3 ? 'chef' : 'danseur', createTime: 1700000000 + i }));
  return {
    log, items,
    bridge: {
      isOpen: () => true, open: async () => ({ opened: true }),
      context: async () => ({ loggedIn: true, secUid: 'MS4wLjABAAAAtestsecuid', uniqueId: 'moi', nickname: 'Moi' }),
      listReposts: async ({ cursor }) => {
        const page = Number(cursor) / 3; log.push(['list', cursor]);
        return { ok: true, items: items.slice(page * 3, page * 3 + 3), hasMore: page + 1 < pages, cursor: String((page + 1) * 3) };
      },
      removeRepost: async (id) => {
        log.push(['remove', id]);
        if (refusals > 0) { refusals--; return { ok: false, httpStatus: 429 }; }
        return { ok: true, httpStatus: 200 };
      },
    },
  };
}

await check('TikTok : inventaire paginé, filtres, archive avant retrait, cadence', async () => {
  const db = newDb(); online(db);
  let t = 0; const sleeps = [];
  const tk = fakeTikTok();
  const app = tiktokRouter(db, { bridge: () => tk.bridge, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; await new Promise((r) => setImmediate(r)); } });
  const scan = await call(app, 'POST', '/scan');
  assert.equal(scan.status, 200);
  const done = (id) => until(async () => { const j = (await call(app, 'GET', '/jobs')).data.find((x) => x.id === id); return !['running', 'paused', 'cooldown'].includes(j.status) && j; });
  assert.equal((await done(scan.data.jobId)).status, 'done');
  assert.equal((await call(app, 'GET', '/status')).data.count, 6);
  assert.equal((await call(app, 'GET', '/reposts?q=%23fun')).data.total, 3);
  assert.equal((await call(app, 'GET', '/reposts?author=@chef')).data.total, 3);
  assert.equal((await call(app, 'POST', '/jobs', { ids: [tk.items[0].id] })).status, 400); // confirmation requise
  assert.equal((await call(app, 'POST', '/jobs', { ids: ['999'], confirm: true })).status, 400); // inconnu
  const ids = [tk.items[0].id, tk.items[1].id];
  sleeps.length = 0;
  const job = await call(app, 'POST', '/jobs', { ids, confirm: true, intervalSec: 5 });
  const j = await done(job.data.jobId);
  assert.equal(j.status, 'done'); assert.equal(j.done, 2);
  assert.equal(sleeps.filter((ms) => ms === 250).length >= 20, true); // ~5 s entre les deux retraits (pas de 250 ms)
  const arch = db.prepare("SELECT * FROM discordArchive WHERE platform='tiktok' ORDER BY rowid").all();
  assert.equal(arch.length, 2); assert.equal(arch[0].action, 'unrepost'); assert.match(JSON.parse(arch[0].meta).url, /\/video\/7000000000000000000$/);
  assert.equal((await call(app, 'GET', '/status')).data.count, 4);
});

await check('TikTok : refus -> refroidissement puis reprise ; 3 refus -> arrêt ; hors-ligne refusé', async () => {
  const db = newDb();
  let t = 0;
  const tk = fakeTikTok({ refuseRemovals: 1 });
  const app = tiktokRouter(db, { bridge: () => tk.bridge, now: () => t, sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); } });
  assert.equal((await call(app, 'POST', '/scan')).status, 409); // hors-ligne
  online(db);
  const done = (id) => until(async () => { const j = (await call(app, 'GET', '/jobs')).data.find((x) => x.id === id); return !['running', 'paused', 'cooldown'].includes(j.status) && j; });
  await done((await call(app, 'POST', '/scan')).data.jobId);
  const j1 = await done((await call(app, 'POST', '/jobs', { ids: [tk.items[2].id], confirm: true })).data.jobId);
  assert.equal(j1.status, 'done'); assert.equal(j1.done, 1);
  assert(t >= 15 * 60_000); // une pause de refroidissement
  assert.equal(db.prepare("SELECT COUNT(*) n FROM discordArchive WHERE platform='tiktok'").get().n, 1); // pas de double archive
  const tk2 = fakeTikTok({ refuseRemovals: 99 });
  const app2 = tiktokRouter(db, { bridge: () => tk2.bridge, now: () => t, sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); } });
  await done((await call(app2, 'POST', '/scan')).data.jobId);
  const j2 = await done((await call(app2, 'POST', '/jobs', { all: true, confirm: true })).data.jobId);
  assert.equal(j2.status, 'failed'); assert.match(j2.error, /réessayez dans une heure/);
  assert.equal(tk2.log.filter((x) => x[0] === 'remove').length, 3);
});

await check('TikTok : pause puis annulation sans retrait supplémentaire', async () => {
  const db = newDb(); online(db);
  let t = 0;
  const tk = fakeTikTok({ pages: 3 });
  const app = tiktokRouter(db, { bridge: () => tk.bridge, now: () => t, sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); } });
  const done = (id) => until(async () => { const j = (await call(app, 'GET', '/jobs')).data.find((x) => x.id === id); return !['running', 'paused', 'cooldown'].includes(j.status) && j; });
  await done((await call(app, 'POST', '/scan')).data.jobId);
  const id = (await call(app, 'POST', '/jobs', { all: true, confirm: true, intervalSec: 60 })).data.jobId;
  await until(() => tk.log.some((x) => x[0] === 'remove'));
  assert.equal((await call(app, 'POST', `/jobs/${id}/pause`)).status, 200);
  assert.equal((await call(app, 'POST', '/jobs', { all: true, confirm: true })).status, 409); // une seule opération
  assert.equal((await call(app, 'POST', `/jobs/${id}/cancel`)).status, 200);
  const j = await done(id);
  assert.equal(j.status, 'cancelled');
  assert.equal(tk.log.filter((x) => x[0] === 'remove').length, 1);
});

// ---------- Discord : protections ----------
await check('protections : épinglés, pièces jointes, mots exclus, normalisation', () => {
  const p = protectionParams({ keepPinned: true, excludeWords: ' Adresse ,  , anniv,Adresse', onlyAttachments: 'oui' });
  assert.deepEqual(p, { keepPinned: true, onlyAttachments: false, excludeWords: ['Adresse', 'anniv'] });
  const keep = protectionFilter(p);
  assert.equal(keep({ content: 'mon adresse est', attachments: [] }), false);
  assert.equal(keep({ content: 'bonjour', pinned: true, attachments: [] }), false);
  assert.equal(keep({ content: 'bonjour', attachments: [] }), true);
  assert.equal(protectionFilter({}), null);
  const files = protectionFilter({ onlyAttachments: true });
  assert.equal(files({ content: 'x', attachments: [] }), false);
  assert.equal(files({ content: 'x', attachments: [{ id: 1 }] }), true);
});


// ---------- Corrections issues de la revue Codex ----------
await check('update : requêtes /install concurrentes -> une seule installation, état préservé', async () => {
  const db = newDb(), dir = mkdtempSync(join(tmpdir(), 'forget-upd-'));
  const { fetchImpl } = githubMock();
  let installs = 0;
  globalThis.__FORGET_INSTALL_UPDATE = async () => { installs++; };
  try {
    const app = updateRouter(db, { fetchImpl, downloadDir: dir, currentVersion: '4.3.0' });
    await call(app, 'PUT', '/repo', { repo: 'me/forget' });
    await call(app, 'POST', '/check');
    const codes = [(await call(app, 'POST', '/install')).status, (await call(app, 'POST', '/install')).status, (await call(app, 'POST', '/install')).status];
    assert.deepEqual(codes, [200, 409, 409]);
    assert.notEqual((await call(app, 'GET', '/')).data.state.phase, 'error');
    assert.equal((await call(app, 'POST', '/check')).status, 409);
    await until(() => installs);
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    assert.equal(installs, 1);
  } finally { delete globalThis.__FORGET_INSTALL_UPDATE; rmSync(dir, { recursive: true, force: true }); }
});

await check('update : erreur d’écriture -> état error, pas de crash', async () => {
  const { mkdirSync } = await import('node:fs');
  const db = newDb(), dir = mkdtempSync(join(tmpdir(), 'forget-upd-'));
  mkdirSync(join(dir, 'Forget-4.4.0.exe')); // un dossier à la place du fichier : erreur à l'ouverture du flux
  globalThis.__FORGET_INSTALL_UPDATE = async () => { throw new Error('ne doit pas être appelé'); };
  try {
    const app = updateRouter(db, { fetchImpl: githubMock().fetchImpl, downloadDir: dir, currentVersion: '4.3.0' });
    await call(app, 'PUT', '/repo', { repo: 'me/forget' });
    await call(app, 'POST', '/check'); await call(app, 'POST', '/install');
    const st = await until(async () => { const s = (await call(app, 'GET', '/')).data.state; return s.phase === 'error' && s; });
    assert.match(st.error, /nouvel exécutable impossible/i);
    assert.equal((await call(app, 'POST', '/check')).status, 200); // verrou levé après l'échec
  } finally { delete globalThis.__FORGET_INSTALL_UPDATE; rmSync(dir, { recursive: true, force: true }); }
});

await check('OAuth : renouvellements simultanés groupés ; déconnexion pendant un renouvellement respectée', async () => {
  const db = newDb(); online(db);
  let t = Date.now();
  const { fetchImpl: base, seen } = oauthMock();
  let gate = null;
  const fetchImpl = async (url, init) => {
    if (gate && new URL(url).pathname === '/2/oauth2/token' && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') await gate;
    return base(url, init);
  };
  globalThis.__FORGET_CIPHER = { encrypt: (s) => 'c:' + s, decrypt: (s) => s.slice(2) };
  globalThis.__FORGET_OAUTH_WINDOW = async ({ authorizeUrl, redirectUri }) => ({ url: `${redirectUri}?state=${new URL(authorizeUrl).searchParams.get('state')}&code=GOOD` });
  try {
    const app = socialRouter(db, { fetchImpl, now: () => t, sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); } });
    assert.equal((await call(app, 'POST', '/twitter/oauth', { clientId: 'myclient', redirectUri: 'http://127.0.0.1:53682/cb' })).status, 200);
    t += 7200 * 1000;
    const r = await Promise.all([call(app, 'GET', '/twitter/posts'), call(app, 'GET', '/twitter/posts'), call(app, 'GET', '/twitter/posts')]);
    assert.deepEqual(r.map((x) => x.status), [200, 200, 200]);
    assert.equal(seen.token.filter((x) => x.form.grant_type === 'refresh_token').length, 1);
    // Déconnexion pendant un renouvellement bloqué.
    t += 7200 * 1000;
    let open; gate = new Promise((ok) => { open = ok; });
    const pending = call(app, 'GET', '/twitter/posts');
    for (let i = 0; i < 20; i++) await new Promise((r2) => setImmediate(r2));
    assert.equal((await call(app, 'DELETE', '/twitter/connect')).status, 200);
    open();
    assert.equal((await pending).status, 409);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM socialAccount WHERE provider='twitter'").get().n, 0);
    assert.equal((await call(app, 'GET', '/twitter/status')).data.connected, false);
  } finally { delete globalThis.__FORGET_OAUTH_WINDOW; delete globalThis.__FORGET_CIPHER; }
});

await check('TikTok : changement de compte pendant un retrait -> arrêt, aucun retrait sur l’autre compte', async () => {
  const db = newDb(); online(db);
  let t = 0;
  const tk = fakeTikTok();
  const app = tiktokRouter(db, { bridge: () => tk.bridge, now: () => t, sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); } });
  const done = (id) => until(async () => { const j = (await call(app, 'GET', '/jobs')).data.find((x) => x.id === id); return !['running', 'paused', 'cooldown'].includes(j.status) && j; });
  await done((await call(app, 'POST', '/scan')).data.jobId);
  const realRemove = tk.bridge.removeRepost;
  tk.bridge.removeRepost = async (id) => { const r = await realRemove(id); tk.bridge.context = async () => ({ loggedIn: true, secUid: 'MS4wLjABAAAAautrecompte' }); return r; };
  const j = await done((await call(app, 'POST', '/jobs', { all: true, confirm: true })).data.jobId);
  assert.equal(j.status, 'failed'); assert.match(j.error, /changé de compte/);
  assert.equal(tk.log.filter((x) => x[0] === 'remove').length, 1);
});

await check('TikTok : même vidéo republiée par deux comptes ; pause pendant un refroidissement', async () => {
  const db = newDb(); online(db);
  let t = 0;
  const tk = fakeTikTok({ pages: 1, refuseRemovals: 1 });
  const app = tiktokRouter(db, { bridge: () => tk.bridge, now: () => t, sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); } });
  const done = (id) => until(async () => { const j = (await call(app, 'GET', '/jobs')).data.find((x) => x.id === id); return !['running', 'paused', 'cooldown'].includes(j.status) && j; });
  await done((await call(app, 'POST', '/scan')).data.jobId);
  const ctxA = tk.bridge.context;
  tk.bridge.context = async () => ({ loggedIn: true, secUid: 'MS4wLjABAAAAcompteB', uniqueId: 'b' });
  await done((await call(app, 'POST', '/scan')).data.jobId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tiktokRepost').get().n, 6); // 3 vidéos x 2 comptes
  tk.bridge.context = ctxA;
  await call(app, 'POST', '/session');
  assert.equal((await call(app, 'GET', '/status')).data.count, 3);
  // Refroidissement (1er refus) puis pause : le statut affiché devient « paused » et le reste après le refroidissement.
  let slow = true;
  const app2 = tiktokRouter(db, { bridge: () => tk.bridge, now: () => t, sleep: async (ms) => { t += slow ? Math.min(ms, 1000) : ms; await new Promise((r) => setImmediate(r)); } });
  await call(app2, 'POST', '/session');
  const id = (await call(app2, 'POST', '/jobs', { ids: [tk.items[0].id], confirm: true })).data.jobId;
  await until(async () => (await call(app2, 'GET', '/jobs')).data.find((x) => x.id === id).status === 'cooldown');
  await call(app2, 'POST', `/jobs/${id}/pause`);
  assert.equal((await call(app2, 'GET', '/jobs')).data.find((x) => x.id === id).status, 'paused');
  slow = false;
  for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
  assert.equal((await call(app2, 'GET', '/jobs')).data.find((x) => x.id === id).status, 'paused');
  await call(app2, 'POST', `/jobs/${id}/resume`);
  const j = await until(async () => { const x = (await call(app2, 'GET', '/jobs')).data.find((y) => y.id === id); return x.status === 'done' && x; });
  assert.equal(j.done, 1);
});

await check('Discord : annulation pendant l’attente d’un 429 -> aucun nouvel envoi du bulk-delete', async () => {
  const { initDiscord, discordRouter, setTransport, waitForJob } = await import('../src/discord/index.mjs');
  const { msToSnowflake } = await import('../src/discord/util.mjs');
  const { Hono } = await import('hono');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS setting(key TEXT PRIMARY KEY, value TEXT)');
  let vnow = 0; const calls = [];
  const ids = [msToSnowflake(Date.now() - 60_000), msToSnowflake(Date.now() - 30_000)];
  const raw = (id) => ({ id, channel_id: 'c1', author: { id: 'me', username: 'moi' }, content: 'x', timestamp: new Date().toISOString(), attachments: [] });
  setTransport({ now: () => vnow, sleep: (ms) => { vnow += ms; return new Promise((r) => setImmediate(r)); }, fetchImpl: async (url, init) => {
    const u = new URL(url); const path = u.pathname.replace('/api/v10', ''); calls.push(`${init.method} ${path}`);
    if (path === '/users/@me') return json({ id: 'me', username: 'moi' });
    if (init.method === 'GET' && path === '/channels/c1/messages') return json(ids.filter((i) => i === u.searchParams.get('around')).map(raw));
    if (path.endsWith('/bulk-delete')) return json({ message: 'rate limited', retry_after: 3600, global: false }, { status: 429 });
    return json({}, { status: 404 });
  } });
  initDiscord(db);
  const app = new Hono(); app.route('/d', discordRouter());
  assert.equal((await call(app, 'POST', '/d/token', { token: 'tok' })).status, 200);
  const jobId = (await call(app, 'POST', '/d/jobs/delete', { channelId: 'c1', messageIds: ids, speed: { mode: 'adaptive' } })).data.jobId;
  await until(() => calls.some((c) => c.endsWith('/bulk-delete')));
  assert.equal((await call(app, 'POST', `/d/jobs/${jobId}/cancel`)).status, 200);
  await waitForJob(jobId);
  assert.equal(calls.filter((c) => c.endsWith('/bulk-delete')).length, 1);
  assert.equal(calls.filter((c) => c.startsWith('DELETE')).length, 0);
  assert.equal((await call(app, 'GET', `/d/jobs/${jobId}`)).data.status, 'cancelled');
});

console.log(results.join('\n'));
const total = results.length;
console.log(pass === total ? `PASS ${pass}/${total}` : `FAIL ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
