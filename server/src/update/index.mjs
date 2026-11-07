// On-demand update: check the latest GitHub release, download the installer,
// verify its SHA-256 (SHA256SUMS.txt from the same release), then hand it to Electron.
// No automatic checks: every network call starts with a user click.
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_UPDATE_REPO, USER_AGENT, VERSION } from '../version.mjs';

export const UPDATE_HOSTS = ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const EXE_RE = /^Forget-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.exe$/i; // single portable executable
const SUMS_RE = /^SHA256SUMS(\.txt)?$/i;
const KEY = 'update.repo';

/** Compare two x.y.z versions (v prefix allowed; prerelease is lower than the final version). */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim());
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' } : null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) throw new Error(`invalid version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Extract a file hash from SHA256SUMS ("<hash>  <name>" or "<hash> *<name>"). */
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
  let release = null; // last check
  let state = { phase: 'idle' }; // idle | checking | downloading | verifying | ready | installing | error
  let busy = false; // installation lock: independent of displayed status (a 409 rejection must not release it)

  const getRepo = () => {
    try {
      const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(KEY);
      const v = row ? JSON.parse(row.value) : '';
      if (typeof v === 'string' && REPO_RE.test(v)) return v;
    } catch { /*default */ }
    return REPO_RE.test(DEFAULT_UPDATE_REPO) ? DEFAULT_UPDATE_REPO : '';
  };

  // Follow redirects manually to check every host (the network lock only sees the first URL).
  async function get(url, accept) {
    let target = url;
    for (let hop = 0; hop < 5; hop++) {
      const u = new URL(target);
      if (u.protocol !== 'https:' || !UPDATE_HOSTS.includes(u.hostname)) throw fail(`Update destination refused: ${u.hostname}`, 502);
      let res;
      try {
        res = await fetchImpl(u.href, { redirect: 'manual', headers: { Accept: accept, 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10 * 60_000) });
      } catch (e) {
        const msg = String(e?.message || '');
        if (/offline|not allowed/i.test(msg)) throw fail('Offline mode is on: turn it off in Settings > Privacy to check for updates.', 409);
        throw fail('GitHub is unreachable. Check your connection.', 502);
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw fail('Invalid redirect', 502);
        target = new URL(loc, u).href;
        continue;
      }
      return res;
    }
    throw fail('Trop de redirections', 502);
  }

  async function check() {
    const repo = getRepo();
    if (!repo) throw fail('Update repository not configured (Settings > Updates).', 409);
    state = { phase: 'checking' };
    const res = await get(`https://api.github.com/repos/${repo}/releases/latest`, 'application/vnd.github+json');
    if (res.status === 404) throw fail(`No release published on ${repo}.`, 404);
    if (res.status === 403 || res.status === 429) throw fail('GitHub API limit reached: try again later.', 429);
    if (!res.ok) throw fail(`GitHub answered HTTP ${res.status}.`, 502);
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
    if (!sumsRes.ok) throw fail(`Checksum file unreadable (HTTP ${sumsRes.status}).`, 502);
    const expected = hashFor(await sumsRes.text(), r.asset.name);
    if (!expected) throw fail(`No SHA-256 checksum for ${r.asset.name}: update refused.`, 422);
    const res = await get(r.asset.url, 'application/octet-stream');
    if (!res.ok || !res.body) throw fail(`Download failed (HTTP ${res.status}).`, 502);
    mkdirSync(downloadDir, { recursive: true });
    const file = join(downloadDir, r.asset.name.replace(/[^A-Za-z0-9._-]/g, '_'));
    const total = Number(res.headers.get('content-length')) || r.asset.size || 0;
    const hash = createHash('sha256');
    const out = createWriteStream(file);
    let received = 0, writeError = null;
    out.on('error', (e) => { writeError = e; out.emit('drain'); }); // disk full, access denied: do not crash the process
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
      try { rmSync(file, { force: true }); } catch { /*best-effort cleanup: the original error takes precedence */ }
      throw e.status ? e : fail(`Could not write the new executable: ${e.message}`, 500);
    }
    state = { phase: 'verifying', received, total };
    const actual = hash.digest('hex');
    if (actual !== expected) { rmSync(file, { force: true }); throw fail('SHA-256 mismatch: file deleted, update refused.', 422); }
    return { file, sha256: actual };
  }

  // Request errors (409, 400, etc.) do not change the state of an update in progress.
  app.onError((e, c) => {
    if (!busy && state.phase === 'checking') state = { phase: 'error', error: e.message };
    return c.json({ error: e.message }, [400, 404, 409, 422, 429, 501, 502].includes(e.status) ? e.status : 500);
  });
  app.get('/', (c) => c.json({ current: currentVersion, repo: getRepo(), state, release: publicRelease(), installer: typeof globalThis.__FORGET_INSTALL_UPDATE === 'function' }));
  app.put('/repo', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const repo = typeof b.repo === 'string' ? b.repo.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$|\/$/g, '') : '';
    if (repo && !REPO_RE.test(repo)) throw fail('Expected format: owner/repository');
    db.prepare('INSERT INTO setting(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(repo));
    release = null;
    return c.json({ repo: getRepo() });
  });
  app.post('/check', async (c) => {
    if (busy) throw fail('An update is already in progress.', 409);
    return c.json(await check());
  });
  app.post('/install', async (c) => {
    if (busy) throw fail('An update is already in progress.', 409);
    if (!release?.available) throw fail('Check first that a new version is available.', 409);
    if (!release.asset || !release.sums) throw fail('The release has no verifiable executable (Forget-<version>.exe + SHA256SUMS.txt).', 422);
    const hook = globalThis.__FORGET_INSTALL_UPDATE;
    if (typeof hook !== 'function') throw fail('Automatic update is only available in Forget.exe (portable version).', 501);
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
