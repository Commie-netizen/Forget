// Privacy layer: network lock (fetch wrapper) and offline state.
// No outgoing calls from this module; state persisted only in the setting table.
import { Hono } from 'hono';

const KEY = 'privacy.offline';
// Updates: only on request ("Check for updates" button), never in the background.
const UPDATE_HOSTS = ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
// OAuth: code exchange and X / Reddit token refresh.
const OAUTH_HOSTS = ['www.reddit.com'];
export const ALLOWED_HOSTS = ['discord.com', 'gateway.discord.gg', 'cdn.discordapp.com', 'media.discordapp.net', 'api.x.com', 'oauth.reddit.com', ...OAUTH_HOSTS, ...UPDATE_HOSTS];
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1'];
const GUARD = Symbol.for('forget.networkGuard');
const PRIVACY_NOTE = '100% local app: no online Forget account, no telemetry. '
  + 'In offline mode (default), no outgoing connection is allowed; '
  + 'otherwise the Discord, X and Reddit APIs are allowed, plus GitHub when you click "Check for updates". '
  + 'Facebook, Instagram and TikTok windows only open when you ask.';

let guardDb = null; // last database bound to the lock
const stats = { blocked: 0, allowed: 0, lastDestination: null, lastBlockedHost: null };
const blockedHosts = new Set();

// Read on each outgoing request: statement prepared once per database.
const readStmts = new WeakMap();
function readOffline(db) {
  try {
    let st = db && readStmts.get(db);
    if (db && !st) { st = db.prepare('SELECT value FROM setting WHERE key = ?'); readStmts.set(db, st); }
    const row = st?.get(KEY);
    if (!row) return true;
    return JSON.parse(row.value) !== false;
  } catch {
    return true; // when in doubt: offline
  }
}

function writeOffline(db, offline) {
  db.prepare('INSERT INTO setting(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(KEY, JSON.stringify(offline));
}

function hostOf(input) {
  try {
    const u = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : input && typeof input.url === 'string' ? input.url
      : String(input);
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function getNetworkStats() {
  return { ...stats, blockedHosts: [...blockedHosts] };
}

export function resetNetworkStats() {
  stats.blocked = 0; stats.allowed = 0; stats.lastDestination = null; stats.lastBlockedHost = null;
  blockedHosts.clear();
}

export function installNetworkGuard(db) {
  guardDb = db;
  const current = globalThis.fetch;
  if (current && current[GUARD]) return db; // already installed: no duplicate wrapper
  const inner = current;
  const guarded = async function guardedFetch(input, init) {
    const host = hostOf(input);
    stats.lastDestination = host || null;
    if (!LOCAL_HOSTS.includes(host)) {
      let err = null;
      if (readOffline(guardDb)) err = new TypeError('offline mode: network blocked');
      else if (!ALLOWED_HOSTS.includes(host)) err = new TypeError(`host not allowed: ${host}`);
      if (err) {
        stats.blocked++; stats.lastBlockedHost = host || null;
        if (host) blockedHosts.add(host);
        throw err;
      }
    }
    stats.allowed++;
    if (typeof inner !== 'function') throw new TypeError('fetch unavailable');
    return inner.call(globalThis, input, init);
  };
  Object.defineProperty(guarded, GUARD, { value: true });
  globalThis.fetch = guarded;
  return db;
}

function state(db) {
  return {
    offline: readOffline(db),
    allowed: [...ALLOWED_HOSTS],
    blockedHosts: [...blockedHosts],
    stats: getNetworkStats(),
    telemetry: false,
    exits: { forget: false },
    privacyNote: PRIVACY_NOTE,
  };
}

export function privacyRouter(db) {
  const app = new Hono();
  app.get('/', (c) => c.json(state(db)));
  app.patch('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || typeof body.offline !== 'boolean') {
      return c.json({ error: 'offline must be a boolean' }, 400);
    }
    writeOffline(db, body.offline);
    return c.json(state(db));
  });
  app.post('/reset-stats', (c) => {
    resetNetworkStats();
    return c.json({ ok: true });
  });
  return app;
}
