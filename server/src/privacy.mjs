// Couche de confidentialité : verrou réseau (enveloppe de fetch) + état hors-ligne.
// Aucun appel sortant depuis ce module ; état persisté uniquement dans la table `setting`.
import { Hono } from 'hono';

const KEY = 'privacy.offline';
// Mises à jour : uniquement à la demande (bouton « Rechercher une mise à jour »), jamais en tâche de fond.
const UPDATE_HOSTS = ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
// OAuth : échange du code et renouvellement des jetons X / Reddit.
const OAUTH_HOSTS = ['www.reddit.com'];
export const ALLOWED_HOSTS = ['discord.com', 'gateway.discord.gg', 'cdn.discordapp.com', 'media.discordapp.net', 'api.x.com', 'oauth.reddit.com', ...OAUTH_HOSTS, ...UPDATE_HOSTS];
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1'];
const GUARD = Symbol.for('forget.networkGuard');
const PRIVACY_NOTE = 'Application 100 % locale : aucun compte Forget en ligne, aucune télémétrie. '
  + 'En mode hors-ligne (défaut), aucune connexion sortante n’est autorisée ; '
  + 'sinon les API Discord, X et Reddit sont autorisées, ainsi que GitHub quand vous cliquez sur « Rechercher une mise à jour ». '
  + 'Les fenêtres Facebook, Instagram et TikTok s’ouvrent uniquement sur votre demande.';

let guardDb = null; // dernière base liée au verrou
const stats = { blocked: 0, allowed: 0, lastDestination: null, lastBlockedHost: null };
const blockedHosts = new Set();

// Lu à chaque requête sortante : requête préparée une seule fois par base.
const readStmts = new WeakMap();
function readOffline(db) {
  try {
    let st = db && readStmts.get(db);
    if (db && !st) { st = db.prepare('SELECT value FROM setting WHERE key = ?'); readStmts.set(db, st); }
    const row = st?.get(KEY);
    if (!row) return true;
    return JSON.parse(row.value) !== false;
  } catch {
    return true; // en cas de doute : hors-ligne
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
  if (current && current[GUARD]) return db; // déjà posé : pas de double enveloppe
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
      return c.json({ error: 'offline doit être un booléen' }, 400);
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
