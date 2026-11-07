// Mise à jour à la demande : vérifie la dernière release GitHub, télécharge l'installeur,
// contrôle son SHA-256 (fichier SHA256SUMS.txt de la même release) puis le confie à Electron.
// Aucune vérification automatique : chaque appel réseau part d'un clic de l'utilisateur.
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_UPDATE_REPO, USER_AGENT, VERSION } from '../version.mjs';

export const UPDATE_HOSTS = ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const EXE_RE = /^Forget-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.exe$/i; // executable portable unique
const SUMS_RE = /^SHA256SUMS(\.txt)?$/i;
const KEY = 'update.repo';

/** Compare deux versions x.y.z (préfixe v toléré ; une pré-version est inférieure à la version finale). */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim());
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' } : null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) throw new Error(`version invalide : ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Extrait le hash d'un fichier depuis un SHA256SUMS (« <hash>  <nom> » ou « <hash> *<nom> »). */
export function hashFor(sums, name) {
  for (const line of String(sums).split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2].trim() === name) return m[1].toLowerCase();
  }
  return null;
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function updateRouter(db, {
  fetchImpl = (...a) => fetch(...a), downloadDir = join(tmpdir(), 'forget-update'), currentVersion = VERSION,
} = {}) {
  const app = new Hono();
  let release = null; // dernière vérification
  let state = { phase: 'idle' }; // idle | checking | downloading | verifying | ready | installing | error
  let busy = false; // verrou d'installation : indépendant de l'état affiché (un refus 409 ne doit pas le lever)

  const getRepo = () => {
    try {
      const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(KEY);
      const v = row ? JSON.parse(row.value) : '';
      if (typeof v === 'string' && REPO_RE.test(v)) return v;
    } catch { /* défaut */ }
    return REPO_RE.test(DEFAULT_UPDATE_REPO) ? DEFAULT_UPDATE_REPO : '';
  };

  // Suit les redirections à la main pour contrôler chaque hôte (le verrou réseau ne voit que la 1re URL).
  async function get(url, accept) {
    let target = url;
    for (let hop = 0; hop < 5; hop++) {
      const u = new URL(target);
      if (u.protocol !== 'https:' || !UPDATE_HOSTS.includes(u.hostname)) throw fail(`Destination de mise à jour refusée : ${u.hostname}`, 502);
      let res;
      try {
        res = await fetchImpl(u.href, { redirect: 'manual', headers: { Accept: accept, 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10 * 60_000) });
      } catch (e) {
        const msg = String(e?.message || '');
        if (/offline|not allowed/i.test(msg)) throw fail('Mode hors-ligne actif : désactivez-le dans Réglages → Confidentialité pour vérifier les mises à jour.', 409);
        throw fail('GitHub est injoignable. Vérifiez votre connexion.', 502);
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw fail('Redirection invalide', 502);
        target = new URL(loc, u).href;
        continue;
      }
      return res;
    }
    throw fail('Trop de redirections', 502);
  }

  async function check() {
    const repo = getRepo();
    if (!repo) throw fail('Dépôt GitHub de mise à jour non configuré (Réglages → Mises à jour).', 409);
    state = { phase: 'checking' };
    const res = await get(`https://api.github.com/repos/${repo}/releases/latest`, 'application/vnd.github+json');
    if (res.status === 404) throw fail(`Aucune release publiée sur ${repo}.`, 404);
    if (res.status === 403 || res.status === 429) throw fail('Limite de l’API GitHub atteinte : réessayez plus tard.', 429);
    if (!res.ok) throw fail(`GitHub a répondu HTTP ${res.status}.`, 502);
    const data = await res.json();
    const latest = String(data.tag_name || '').replace(/^v/i, '');
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const setup = assets.find((a) => EXE_RE.test(a.name || ''));
    const sums = assets.find((a) => SUMS_RE.test(a.name || ''));
    const available = compareVersions(latest, currentVersion) > 0;
    release = {
      repo, latest, available, name: data.name || data.tag_name, notes: String(data.body || '').slice(0, 20000),
      url: typeof data.html_url === 'string' && data.html_url.startsWith('https://github.com/') ? data.html_url : null,
      publishedAt: data.published_at || null,
      asset: setup ? { name: setup.name, size: setup.size, url: setup.browser_download_url } : null,
      sums: sums ? { name: sums.name, url: sums.browser_download_url } : null,
    };
    state = { phase: 'idle' };
    return publicRelease();
  }

  const publicRelease = () => release && {
    current: currentVersion, latest: release.latest, available: release.available, name: release.name, notes: release.notes,
    url: release.url, publishedAt: release.publishedAt, installable: !!(release.available && release.asset && release.sums),
    asset: release.asset ? { name: release.asset.name, size: release.asset.size } : null, checksum: !!release.sums,
  };

  async function download() {
    const r = release;
    const sumsRes = await get(r.sums.url, 'application/octet-stream');
    if (!sumsRes.ok) throw fail(`Fichier de sommes de contrôle illisible (HTTP ${sumsRes.status}).`, 502);
    const expected = hashFor(await sumsRes.text(), r.asset.name);
    if (!expected) throw fail(`Aucune somme SHA-256 pour ${r.asset.name} : installation refusée.`, 422);
    const res = await get(r.asset.url, 'application/octet-stream');
    if (!res.ok || !res.body) throw fail(`Téléchargement impossible (HTTP ${res.status}).`, 502);
    mkdirSync(downloadDir, { recursive: true });
    const file = join(downloadDir, r.asset.name.replace(/[^A-Za-z0-9._-]/g, '_'));
    const total = Number(res.headers.get('content-length')) || r.asset.size || 0;
    const hash = createHash('sha256');
    const out = createWriteStream(file);
    let received = 0, writeError = null;
    out.on('error', (e) => { writeError = e; out.emit('drain'); }); // disque plein, accès refusé : pas de crash du processus
    try {
      for await (const chunk of res.body) {
        if (writeError) throw writeError;
        hash.update(chunk);
        received += chunk.length;
        if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
        if (writeError) throw writeError;
        state = { phase: 'downloading', received, total };
      }
      await new Promise((ok, ko) => out.end((e) => (e || writeError ? ko(e || writeError) : ok())));
    } catch (e) {
      out.destroy();
      try { rmSync(file, { force: true }); } catch { /* nettoyage best effort : l'erreur d'origine prime */ }
      throw e.status ? e : fail(`Écriture du nouvel exécutable impossible : ${e.message}`, 500);
    }
    state = { phase: 'verifying', received, total };
    const actual = hash.digest('hex');
    if (actual !== expected) { rmSync(file, { force: true }); throw fail('Somme SHA-256 différente : fichier supprimé, installation refusée.', 422); }
    return { file, sha256: actual };
  }

  // Les erreurs de requête (409, 400...) ne modifient pas l'état d'une mise à jour en cours.
  app.onError((e, c) => {
    if (!busy && state.phase === 'checking') state = { phase: 'error', error: e.message };
    return c.json({ error: e.message }, [400, 404, 409, 422, 429, 501, 502].includes(e.status) ? e.status : 500);
  });
  app.get('/', (c) => c.json({ current: currentVersion, repo: getRepo(), state, release: publicRelease(), installer: typeof globalThis.__FORGET_INSTALL_UPDATE === 'function' }));
  app.put('/repo', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const repo = typeof b.repo === 'string' ? b.repo.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$|\/$/g, '') : '';
    if (repo && !REPO_RE.test(repo)) throw fail('Format attendu : propriétaire/dépôt');
    db.prepare('INSERT INTO setting(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(repo));
    release = null;
    return c.json({ repo: getRepo() });
  });
  app.post('/check', async (c) => {
    if (busy) throw fail('Mise à jour déjà en cours.', 409);
    return c.json(await check());
  });
  app.post('/install', async (c) => {
    if (busy) throw fail('Mise à jour déjà en cours.', 409);
    if (!release?.available) throw fail('Vérifiez d’abord qu’une nouvelle version est disponible.', 409);
    if (!release.asset || !release.sums) throw fail('La release ne contient pas d’exécutable vérifiable (Forget-<version>.exe + SHA256SUMS.txt).', 422);
    const hook = globalThis.__FORGET_INSTALL_UPDATE;
    if (typeof hook !== 'function') throw fail('Mise à jour automatique disponible uniquement dans Forget.exe (version portable).', 501);
    busy = true;
    state = { phase: 'downloading', received: 0, total: release.asset.size || 0 };
    void (async () => {
      try {
        const { file } = await download();
        state = { phase: 'installing' };
        await hook(file);
      } catch (e) { state = { phase: 'error', error: e.message }; busy = false; }
    })();
    return c.json({ started: true });
  });
  return app;
}
