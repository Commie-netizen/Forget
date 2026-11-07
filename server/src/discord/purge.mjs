// Resumable purges: delete MY messages from a channel, with no cap, in batches of chunkSize.
// Constant memory: read one search page (25), process it, persist the before cursor
// (lowest ID processed), then repeat. No accumulated message array.
import * as store from './store.mjs';
import { discordFetch } from './http.mjs';
import { searchPage } from './search.mjs';
import { archiveMessage } from './archive.mjs';
import { resolveSpeed, makePacer } from './bulk.mjs';
import { msToSnowflake, cmpId, parseTime, BULK_MAX_AGE_MS } from './util.mjs';

export const DEFAULT_CHUNK = 5000;
export const DEFAULT_INTERVAL_SEC = 3600;
export const SCHEDULER_MS = 10_000;

const running = new Map(); // purgeId -> Promise (one execution at a time per purge)
let timer = null;
let stopping = false;

export function startPurge(b) {
  const intv = Number(b.intervalSec), chunk = Number(b.chunkSize);
  const id = store.createPurge({
    channelId: String(b.channelId),
    guildId: b.guildId ? String(b.guildId) : null,
    guildName: b.guildName, channelName: b.channelName,
    chunkSize: Number.isFinite(chunk) && chunk >= 1 ? Math.floor(chunk) : DEFAULT_CHUNK,
    intervalSec: Number.isFinite(intv) && intv >= 1 ? Math.floor(intv) : DEFAULT_INTERVAL_SEC,
    // The UI sends the preset name ("safe", "fast"): accepted as { mode }.
    speed: resolveSpeed(typeof b.speed === 'string' ? { mode: b.speed } : (b.speed ?? { mode: 'safe' })),
    fromTs: parseTime(b.from), toTs: parseTime(b.to),
  });
  triggerPurge(id, true);
  return id;
}

/** Start an execution (deferred one tick to let the HTTP request return). */
function triggerPurge(id, deferred = false) {
  if (running.has(id)) return running.get(id);
  const start = deferred ? new Promise((r) => setImmediate(r)) : Promise.resolve();
  const p = start.then(() => runPurge(id)).catch(() => {}).finally(() => running.delete(id));
  running.set(id, p);
  return p;
}

/** Force immediate execution. Reactivate a failed purge; reject done/cancelled. */
export function runPurgeNow(id) {
  const p = store.getPurge(id);
  if (!p) return { error: 'purge not found', status: 404 };
  if (p.status === 'done' || p.status === 'cancelled') return { error: `purge ${p.status}`, status: 409 };
  if (p.status === 'error') store.updatePurge(id, { status: 'active', error: null });
  triggerPurge(id, true);
  return { ok: true };
}

export function cancelPurge(id) {
  const p = store.getPurge(id);
  if (!p) return false;
  if (p.status === 'active' || p.status === 'error') store.updatePurge(id, { status: 'cancelled', nextRunAt: null });
  return true;
}

export const waitForPurge = (id) => running.get(id) ?? Promise.resolve();
export const waitAllPurges = () => Promise.all([...running.values()]);

/** Trigger active purges whose nextRunAt is due (exported for tests). */
export function tickPurges(at = Date.now()) {
  if (!store.getToken()) return [];
  const due = store.duePurges(at).filter((id) => !running.has(id));
  for (const id of due) triggerPurge(id);
  return due;
}

export function startPurgeScheduler(ms = SCHEDULER_MS) {
  if (timer) return;
  stopping = false;
  timer = setInterval(() => { try { tickPurges(); } catch { /*database closed */ } }, ms);
  timer.unref?.();
}
export function stopPurgeScheduler() {
  stopping = true; // running executions stop after the current page, with the cursor saved
  if (timer) { clearInterval(timer); timer = null; }
}

const isLive = (id) => !stopping && store.getPurge(id)?.status === 'active';

async function runPurge(id) {
  let purge = store.getPurge(id);
  if (!purge || purge.status !== 'active') return;
  const token = store.getToken();
  if (!token) return; // remain active: resume once a token is available
  const me = token.userId;
  const speed = purge.speed ?? resolveSpeed();
  const pace = makePacer(speed.delayMs);
  const cutoff = Date.now() - BULK_MAX_AGE_MS;
  const minId = purge.fromTs ? msToSnowflake(purge.fromTs) : undefined;
  const baseMax = purge.toTs ? msToSnowflake(purge.toTs) : undefined;
  const meta = { channelName: purge.channelName, guildName: purge.guildName };
  let cursor = purge.cursorBefore; // lowest ID already processed
  let doneInRun = 0;
  let exhausted = false;
  let bulkOk = true;
  const acc = { processed: 0, deleted: 0, failed: 0 };

  const flush = () => {
    store.updatePurge(id, {
      cursorBefore: cursor, processed: purge.processed + acc.processed,
      deleted: purge.deleted + acc.deleted, failed: purge.failed + acc.failed,
    });
  };
  const delSingle = async (m) => {
    await pace();
    archiveMessage(m, 'delete', { ...meta, meta: { via: 'purge-single', purgeId: id } });
    try {
      await discordFetch(token.token, 'DELETE', `/channels/${m.channelId}/messages/${m.id}`);
      acc.deleted++;
    } catch (e) {
      if (e.status === 401) throw e;
      if (e.status === 404) acc.deleted++; // already deleted
      else acc.failed++;
    }
  };

  try {
    while (isLive(id) && doneInRun < purge.chunkSize) {
      // maxId = cursor (Discord may treat it as inclusive): then filter id < cursor
      const maxId = cursor ?? baseMax;
      const page = await searchPage(token.token, {
        guildId: purge.guildId ?? undefined, channelId: purge.channelId, authorId: me, minId, maxId, offset: 0,
      }, { pace });
      let msgs = page.messages.filter((m) => m.authorId === me && (cursor === null || cmpId(m.id, cursor) < 0));
      if (!msgs.length) { exhausted = true; break; }
      msgs.sort((a, b) => cmpId(b.id, a.id)); // newest -> oldest
      msgs = msgs.slice(0, purge.chunkSize - doneInRun);

      const recent = bulkOk ? msgs.filter((m) => m.timestamp > cutoff) : [];
      const singles = msgs.filter((m) => !recent.includes(m));
      if (recent.length >= 2) {
        await pace();
        recent.forEach((m) => archiveMessage(m, 'delete', { ...meta, meta: { via: 'purge-bulk', purgeId: id } }));
        try {
          await discordFetch(token.token, 'POST', `/channels/${purge.channelId}/messages/bulk-delete`, { body: { messages: recent.map((m) => m.id) } });
          acc.deleted += recent.length;
        } catch (e) {
          if (e.status === 401) throw e;
          if ([400, 403, 404, 405].includes(e.status)) { bulkOk = false; singles.push(...recent); } // fall back to individual deletion
          else acc.failed += recent.length;
        }
      } else singles.push(...recent);
      let interrupted = false;
      for (const m of singles) {
        if (!isLive(id)) { interrupted = true; break; } // cancellation/shutdown: cursor not advanced, page will be revisited
        await delSingle(m);
      }
      if (interrupted) { flush(); break; }
      const handled = msgs.length;
      acc.processed += handled;
      doneInRun += handled;
      cursor = msgs.reduce((min, m) => (cmpId(m.id, min) < 0 ? m.id : min), cursor ?? msgs[0].id);
      flush();
    }
    const now = Date.now();
    const live = store.getPurge(id)?.status === 'active';
    const patch = { runs: purge.runs + 1, lastRunAt: now };
    if (live && exhausted) Object.assign(patch, { status: 'done', nextRunAt: null });
    else if (live && !stopping) patch.nextRunAt = now + purge.intervalSec * 1000;
    store.updatePurge(id, patch);
  } catch (e) {
    flush();
    store.updatePurge(id, { status: 'error', error: e.message, runs: purge.runs + 1, lastRunAt: Date.now(), nextRunAt: null });
  }
}
