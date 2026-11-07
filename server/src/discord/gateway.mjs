// Disappearing mode: listen to the Discord gateway (MESSAGE_CREATE) and delete the user's own messages after a delay.
// Automatically reconnect with backoff; close when the mode is disabled.
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

/** Start the watcher (idempotent: no duplicate gateway). Return false without a token. */
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
  state.generation++; // invalidate pending callbacks
  state.ready = false;
  clearTimeout(state.hb);
  state.pending.clear(); // discard scheduled deletions
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
  ws.on('error', () => { /*'close' always follows */ });
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

const send = (ws, payload) => { try { ws.send(JSON.stringify(payload)); } catch { /*socket closed */ } };
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
    case 7: case 9: kill(ws); break; // reconnect / invalid session -> 'close' starts a new connection
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
    if (!state.acked) return kill(ws); // no ACK: zombie connection
    state.acked = false;
    send(ws, { op: 1, d: state.seq });
    state.hb = setTimeout(beat, interval);
    state.hb.unref?.();
  };
  state.hb = setTimeout(beat, Math.floor(interval * Math.random())); // jitter recommended for the first heartbeat
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
    if (!state.pending.delete(entry)) return; // mode disabled in the meantime
    const t = store.getToken();
    if (!t) return;
    try {
      archiveMessage(msg, 'disappear', { meta: { delaySec: cfg.delaySec } }); // archive BEFORE deletion
      await discordFetch(t.token, 'DELETE', `/channels/${msg.channelId}/messages/${msg.id}`);
      state.deleted++;
    } catch (e) {
      if (e.status === 404) state.deleted++;
      else state.failed++;
    }
  });
}
