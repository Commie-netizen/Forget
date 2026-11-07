// Mode disparition : écoute le gateway Discord (MESSAGE_CREATE) et supprime mes propres messages après un délai.
// Reconnexion automatique avec backoff ; fermé quand le mode est éteint.
import * as store from './store.mjs';
import { discordFetch, getTransport, sleep } from './http.mjs';
import { archiveMessage } from './archive.mjs';
import { normalizeMessage } from './util.mjs';

export const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
export const SCOPES = ['all', 'guilds', 'dms', 'selected'];

const state = {
  running: false, generation: 0, ws: null, hb: null, seq: null, acked: true,
  ready: false, userId: null, backoff: 1000, pending: new Set(), deleted: 0, failed: 0,
};

export function disappearingStatus() {
  return { ...store.getDisappearing(), running: state.running, ready: state.ready, pending: state.pending.size, deleted: state.deleted, failed: state.failed };
}

/** Démarre le watcher (idempotent : pas de double gateway). Renvoie false sans token. */
export function startDisappearing() {
  if (state.running) return true;
  if (!store.getToken()) return false;
  state.running = true;
  state.backoff = 1000;
  connect(++state.generation);
  return true;
}

export function stopDisappearing() {
  state.running = false;
  state.generation++; // invalide les callbacks en attente
  state.ready = false;
  clearTimeout(state.hb);
  state.pending.clear(); // suppressions programmées abandonnées
  const ws = state.ws;
  state.ws = null;
  try { ws?.close(1000); } catch { /* ignore */ }
}

async function connect(gen) {
  if (!state.running || gen !== state.generation) return;
  let ws;
  try {
    const WS = getTransport().wsImpl ?? (await import('ws')).default;
    if (!state.running || gen !== state.generation) return;
    ws = new WS(GATEWAY_URL);
  } catch {
    return scheduleReconnect(gen);
  }
  state.ws = ws;
  state.seq = null;
  ws.on('message', (raw) => onFrame(gen, ws, raw));
  ws.on('error', () => { /* 'close' suit toujours */ });
  ws.on('close', () => {
    if (state.ws === ws) state.ws = null;
    clearTimeout(state.hb);
    state.ready = false;
    if (state.running && gen === state.generation) scheduleReconnect(gen);
  });
}

async function scheduleReconnect(gen) {
  const delay = state.backoff;
  state.backoff = Math.min(state.backoff * 2, 60000);
  await sleep(delay);
  connect(gen);
}

const send = (ws, payload) => { try { ws.send(JSON.stringify(payload)); } catch { /* socket fermé */ } };
const kill = (ws) => { try { (ws.terminate ?? ws.close).call(ws); } catch { /* ignore */ } };

function onFrame(gen, ws, raw) {
  if (gen !== state.generation) return;
  let f;
  try { f = JSON.parse(String(raw)); } catch { return; }
  if (f.s != null) state.seq = f.s;
  switch (f.op) {
    case 10: { // HELLO : heartbeat + IDENTIFY
      startHeartbeat(gen, ws, f.d.heartbeat_interval);
      const t = store.getToken();
      if (!t) { stopDisappearing(); return; }
      send(ws, { op: 2, d: { token: t.token, properties: { os: 'windows', browser: 'chrome', device: '' } } });
      break;
    }
    case 11: state.acked = true; break;
    case 1: send(ws, { op: 1, d: state.seq }); break;
    case 7: case 9: kill(ws); break; // reconnect / session invalide -> 'close' relance une connexion
    case 0:
      if (f.t === 'READY') { state.ready = true; state.backoff = 1000; state.userId = f.d?.user?.id ?? state.userId; }
      else if (f.t === 'MESSAGE_CREATE') onMessageCreate(f.d);
      break;
  }
}

function startHeartbeat(gen, ws, interval) {
  clearTimeout(state.hb);
  state.acked = true;
  const beat = () => {
    if (gen !== state.generation || ws !== state.ws) return;
    if (!state.acked) return kill(ws); // pas d'ACK : connexion zombie
    state.acked = false;
    send(ws, { op: 1, d: state.seq });
    state.hb = setTimeout(beat, interval);
    state.hb.unref?.();
  };
  state.hb = setTimeout(beat, Math.floor(interval * Math.random())); // jitter conseillé pour le 1er battement
  state.hb.unref?.();
}

export function inScope(cfg, guildId) {
  switch (cfg.scope) {
    case 'guilds': return !!guildId;
    case 'dms': return !guildId;
    case 'selected': return !!guildId && cfg.guildIds.includes(guildId);
    default: return true;
  }
}

function onMessageCreate(d) {
  const cfg = store.getDisappearing();
  const me = state.userId ?? store.getToken()?.userId;
  if (!cfg.enabled || !me || d?.author?.id !== me || !inScope(cfg, d.guild_id)) return;
  const msg = normalizeMessage(d);
  const entry = { id: msg.id };
  state.pending.add(entry);
  sleep(cfg.delaySec * 1000).then(async () => {
    if (!state.pending.delete(entry)) return; // mode éteint entre-temps
    const t = store.getToken();
    if (!t) return;
    try {
      archiveMessage(msg, 'disappear', { meta: { delaySec: cfg.delaySec } }); // archive AVANT suppression
      await discordFetch(t.token, 'DELETE', `/channels/${msg.channelId}/messages/${msg.id}`);
      state.deleted++;
    } catch (e) {
      if (e.status === 404) state.deleted++;
      else state.failed++;
    }
  });
}
