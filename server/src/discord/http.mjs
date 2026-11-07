// Client REST Discord : unique point de sortie réseau (https://discord.com/api/v10 uniquement).
// Gère les 429 (retry_after) avec retry borné. Le transport est injectable pour les tests.
import { createHash } from 'node:crypto';
import { RateLimiter } from './limiter.mjs';
import { USER_AGENT } from '../version.mjs';
export const API_BASE = 'https://discord.com/api/v10';

export class DiscordError extends Error {
  constructor(status, message, data = null) {
    super(message);
    this.name = 'DiscordError';
    this.status = status; // 0 = erreur réseau
    this.data = data;
  }
}

const defaultSleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const defaults = () => ({ fetchImpl: null, wsImpl: null, sleep: defaultSleep, now: () => performance.now() });
let transport = defaults();
const limiters = new Map();
const keyFor = token => createHash('sha256').update(token).digest('hex');
function limiterFor(token) {
  const key = keyFor(token);
  if (!limiters.has(key)) limiters.set(key, new RateLimiter({ now: () => transport.now(), sleep: ms => transport.sleep(ms) }));
  return limiters.get(key);
}
export const rateLimitStatus = token => token ? limiterFor(token).snapshot() : null;

// Remplace partiellement le transport (tests : fetchImpl, wsImpl, sleep).
export function setTransport(patch = {}) { transport = { ...transport, ...patch }; }
export function resetTransport() { transport = defaults(); limiters.clear(); }
export const getTransport = () => transport;
export const sleep = (ms) => transport.sleep(ms);

/**
 * Appel REST. Renvoie { status, data }. Lève DiscordError si statut non 2xx.
 * Sur 429 : attend retry_after (secondes, float) puis retente, jusqu'à maxRetries.
 */
export async function discordFetch(token, method, path, { query, body, maxRetries = 5, onRateLimit, shouldStop } = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const fetchImpl = transport.fetchImpl ?? globalThis.fetch;
  const init = {
    method,
    headers: { Authorization: token, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  for (let attempt = 0; ; attempt++) {
    let res, data = null;
    try {
      ({ res, data } = await limiterFor(token).run(method, path, async () => {
        const res = await fetchImpl(url.toString(), init);
        let data = null;
        const text = await res.text();
        if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
        return { res, data };
      }, shouldStop));
    } catch (err) {
      // Verrou de confidentialité (privacy.mjs) : message actionnable pour l'UI.
      if (err.status === 499) throw err;
      const msg = String(err?.message || '');
      if (/offline|not allowed/i.test(msg)) {
        throw new DiscordError(0, 'Mode hors-ligne actif : activez la connexion dans Réglages → Confidentialité.', null);
      }
      throw new DiscordError(0, 'Réseau Discord indisponible');
    }
    if (res.status === 429) {
      if (attempt >= maxRetries) throw new DiscordError(429, 'Rate limit : trop de tentatives', data);
      let wait = Number(data?.retry_after ?? res.headers?.get?.('retry-after') ?? 1);
      if (!Number.isFinite(wait) || wait < 0) wait = 1;
      const waitMs = Math.ceil(wait * 1000) + attempt * 250; // backoff léger croissant
      onRateLimit?.({ attempt: attempt + 1, retryAfterMs: waitMs, global: !!data?.global });
      // The shared scheduler enforces this deadline for every caller, including retries.
      continue;
    }
    if (!res.ok) throw new DiscordError(res.status, data?.message || `HTTP ${res.status}`, data);
    return { status: res.status, data };
  }
}
