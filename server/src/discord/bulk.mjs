// Bulk deletion/edit jobs: asynchronous, cancellable, with persisted progress.
import * as store from './store.mjs';
import { discordFetch, sleep } from './http.mjs';
import { collectMessages } from './search.mjs';
import { archiveMessage } from './archive.mjs';
import { normalizeMessage, toSnowflake, cmpId, BULK_MAX_AGE_MS, protectionFilter } from './util.mjs';

export const HISTORY_PAGE = 100; // page size for GET /channels/{id}/messages
const GUILD_TEXT_TYPES = new Set([0, 5]); // text and announcement channels
const isDeletableType = (t) => t === 0 || (t >= 6 && t <= 21); // messages/replies; excludes system events

const running = new Map(); // jobId -> Promise (allows tests to wait and supports clean shutdown)

/** Speed modes: safe 900 ms/1, fast 300 ms/2, turbo 120 ms/3, custom (delay >= 150, concurrency 1-4). */
export const SPEED_PRESETS = {
  adaptive: { mode: 'adaptive', delayMs: 0, concurrency: 4 },
  safe: { mode: 'safe', delayMs: 900, concurrency: 1 },
  fast: { mode: 'fast', delayMs: 300, concurrency: 2 },
  turbo: { mode: 'turbo', delayMs: 120, concurrency: 3 },
};
export function resolveSpeed(speed = {}) {
  if (['adaptive', 'fast', 'turbo'].includes(speed.mode)) return { ...SPEED_PRESETS[speed.mode] };
  if (speed.mode === 'custom') {
    const d = Number(speed.delayMs), c = Number(speed.concurrency);
    return {
      mode: 'custom',
      delayMs: Math.max(150, Number.isFinite(d) ? Math.floor(d) : SPEED_PRESETS.safe.delayMs),
      concurrency: Math.min(4, Math.max(1, Number.isFinite(c) ? Math.floor(c) : 1)),
    };
  }
  return { ...SPEED_PRESETS.safe };
}

/** Space request starts at least delayMs apart (shared across concurrent lanes). */
export function makePacer(delayMs) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const slot = Math.max(now, next);
    next = slot + delayMs;
    if (slot > now) await sleep(slot - now);
  };
}

/** Compute the new message content for the editing operation. */
export function applyEdit(content, edit) {
  switch (edit.mode) {
    case 'replace': {
      const find = String(edit.find ?? '');
      if (!find) return content;
      if (edit.regex) return content.replace(new RegExp(find, 'g'), String(edit.replace ?? ''));
      return content.split(find).join(String(edit.replace ?? ''));
    }
    case 'append': return content + String(edit.text ?? '');
    case 'prepend': return String(edit.text ?? '') + content;
    case 'set': return String(edit.text ?? '');
    default: throw new Error(`unknown edit mode: ${edit.mode}`);
  }
}

export function validateEdit(edit) {
  if (!edit || typeof edit !== 'object') return 'edit is required';
  if (edit.mode === 'replace') {
    if (!edit.find) return 'edit.find is required';
    if (String(edit.find).length > 500) return 'edit.find is too long (500 characters max)'; // limit the risk of ReDoS
    if (edit.regex) { try { new RegExp(String(edit.find), 'g'); } catch { return 'invalid regular expression'; } }
    return null;
  }
  if (['append', 'prepend', 'set'].includes(edit.mode)) return typeof edit.text === 'string' ? null : 'edit.text is required';
  return 'invalid edit.mode (replace|append|prepend|set)';
}

function startJob(kind, params) {
  const jobId = store.createJob(kind, params);
  // Deferred start: the HTTP request returns jobId immediately.
  const p = new Promise((resolve) => setImmediate(resolve)).then(() => runJob(jobId, kind, params))
    .catch(() => {}).finally(() => running.delete(jobId));
  running.set(jobId, p);
  return jobId;
}
export const startDeleteJob = (params) => startJob('delete', params);
export const startEditJob = (params) => startJob('edit', params);
export const waitForJob = (jobId) => running.get(jobId) ?? Promise.resolve();

export function cancelJob(jobId) {
  store.requestCancel(jobId);
}
/** Server shutdown: request cancellation of all active jobs. */
export function cancelAllJobs() {
  for (const id of running.keys()) store.requestCancel(id);
}
export async function waitAllJobs() {
  await Promise.all([...running.values()]);
}

/** Run worker on each item across N lanes; each lane checks for cancellation on every iteration. */
async function runPool(items, concurrency, shouldStop, worker) {
  let i = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!shouldStop()) {
      const idx = i++;
      if (idx >= items.length) return;
      await worker(items[idx]);
    }
  });
  await Promise.all(lanes);
}

async function runJob(jobId, kind, params) {
  const token = store.getToken();
  try {
    if (!token) throw new Error('Discord is not connected');
    store.updateJob(jobId, { status: 'running', startedAt: Date.now() });
    const speed = resolveSpeed(params.speed);
    const stats = { progress: 0, deleted: 0, edited: 0, failed: 0 };
    const ctx = {
      jobId, token: token.token, me: token.userId, params, speed, stats,
      pace: makePacer(speed.delayMs),
      shouldStop: () => store.isCancelRequested(jobId),
      log: (level, message, meta) => store.addLog(jobId, level, message, meta),
      onRateLimit: (i) => store.addLog(jobId, 'warn', `429: waiting ${i.retryAfterMs} ms (attempt ${i.attempt})`, i),
      save: () => store.updateJob(jobId, stats),
      archived: new Set(),
      bulkOk: params.allowBulk === false ? false : undefined,
      protect: protectionFilter(params),
    };
    ctx.log('info', `Job ${kind} started (speed ${speed.mode}: ${speed.delayMs} ms, concurrency ${speed.concurrency})`);
    if (kind === 'delete' && useHistory(params)) {
      await runHistoryDelete(ctx);
    } else {
      const messages = await gatherTargets(ctx);
      store.updateJob(jobId, { total: messages.length });
      if (kind === 'delete') await doDelete(ctx, messages);
      else await doEdit(ctx, messages);
    }
    ctx.save();
    const cancelled = ctx.shouldStop();
    store.updateJob(jobId, { status: cancelled ? 'cancelled' : 'done', finishedAt: Date.now() });
    ctx.log('info', cancelled ? 'Job cancelled' : 'Job finished', stats);
  } catch (e) {
    store.addLog(jobId, 'error', e.message);
    store.updateJob(jobId, { status: 'failed', error: e.message, finishedAt: Date.now() });
  }
}

/** List target messages: explicit IDs (fetched individually) or a search of the user's own messages. */
async function gatherTargets(ctx) {
  const { params, token } = ctx;
  const max = Number(params.maxMessages) > 0 ? Number(params.maxMessages) : Infinity;
  if (Array.isArray(params.messageIds) && params.messageIds.length) {
    const ids = [...new Set(params.messageIds.map(String))].slice(0, max);
    const out = [];
    const wanted = new Set(ids), seen = new Set();
    for (const id of ids) {
      if (ctx.shouldStop()) break;
      if (seen.has(id)) continue;
      await ctx.pace();
      try {
        // around=<id>&limit=1 returns the target message (direct access is reserved for bots)
        const { data } = await discordFetch(token, 'GET', `/channels/${params.channelId}/messages`,
          { query: { around: id, limit: params.verifyPages ? 100 : 1 }, onRateLimit: ctx.onRateLimit, shouldStop: ctx.shouldStop });
        for (const raw of data ?? []) {
          if (!wanted.has(raw.id) || seen.has(raw.id)) continue;
          seen.add(raw.id);
          if (raw.author?.id === ctx.me) out.push(normalizeMessage({ ...raw, channel_id: raw.channel_id ?? params.channelId, guild_id: raw.guild_id ?? params.guildId }));
          else { ctx.stats.failed++; ctx.log('warn', `Message ${raw.id}: different author, skipped`); }
        }
        if (!seen.has(id)) {
          seen.add(id); ctx.log('warn', `Message ${id} not found, skipped`);
          if (params.planId) ctx.stats.skipped = (ctx.stats.skipped || 0) + 1;
          else ctx.stats.failed++;
        }
      } catch (e) {
        if (e.status === 401) throw e;
        ctx.log('warn', `Message ${id} illisible : ${e.message}`);
        ctx.stats.failed++;
      }
    }
    return out.sort((a, b) => cmpId(a.id, b.id));
  }
  ctx.log('info', 'Searching my messages (25 per page)');
  const found = await collectMessages(token, {
    guildId: params.guildId, channelId: params.channelId, authorId: ctx.me, content: params.content || undefined,
    minId: toSnowflake(params.after), maxId: toSnowflake(params.before),
  }, {
    max, shouldStop: ctx.shouldStop, pace: ctx.pace, onRateLimit: ctx.onRateLimit,
    onPage: (count, total) => ctx.log('debug', `${count} messages collected (Discord total ${total})`),
  });
  return applyProtection(ctx, found);
}

/** Remove protected messages (pinned, excluded words, etc.) and count them as skipped. */
function applyProtection(ctx, messages) {
  if (!ctx.protect) return messages;
  const kept = messages.filter(ctx.protect);
  const skipped = messages.length - kept.length;
  if (skipped) {
    ctx.stats.skipped = (ctx.stats.skipped || 0) + skipped;
    ctx.log('info', `${skipped} message(s) protected by filters, kept`);
  }
  return kept;
}

function archiveOnce(ctx, msg, action, meta) {
  const key = action + msg.id;
  if (ctx.archived.has(key)) return;
  archiveMessage(msg, action, { meta, channelName: ctx.params.channelName, guildName: ctx.params.guildName });
  ctx.archived.add(key);
}

const doDelete = (ctx, messages) => deleteBatch(ctx, messages);

/** Delete a batch: bulk-delete (< 14 days, per channel, batches of 100), then individual deletion (concurrency = speed.concurrency, global pacer). Archive BEFORE the action; update statistics/progress. ctx.bulkOk becomes false if Discord refuses bulk deletion (DM, permissions), falling back to individual deletion. */
async function deleteBatch(ctx, messages) {
  const { params, token, stats } = ctx;
  const cutoff = Date.now() - BULK_MAX_AGE_MS;
  const single = messages.filter((m) => m.timestamp <= cutoff || ctx.bulkOk === false); // older messages require individual deletion
  const byChannel = new Map();
  for (const m of messages) {
    if (m.timestamp <= cutoff || ctx.bulkOk === false) continue;
    const k = m.channelId ?? params.channelId;
    (byChannel.get(k) ?? byChannel.set(k, []).get(k)).push(m);
  }

  for (const [channelId, list] of byChannel) {
    for (let i = 0; i < list.length; i += 100) {
      if (ctx.shouldStop()) return;
      if (ctx.bulkOk === false) { single.push(...list.slice(i)); break; }
      const batch = list.slice(i, i + 100);
      if (batch.length < 2) { single.push(...batch); continue; }
      await ctx.pace();
      batch.forEach((m) => archiveOnce(ctx, m, 'delete', { via: 'bulk' })); // archive BEFORE the action
      try {
        await discordFetch(token, 'POST', `/channels/${channelId}/messages/bulk-delete`,
          { body: { messages: batch.map((m) => m.id) }, onRateLimit: ctx.onRateLimit, shouldStop: ctx.shouldStop });
        stats.deleted += batch.length;
        stats.progress += batch.length;
      } catch (e) {
        if (e.status === 401) throw e;
        if (e.status === 499) return; // cancelled while waiting for quota: nothing was sent
        if ([400, 403, 404, 405].includes(e.status)) {
          ctx.log('warn', `bulk-delete refused (${e.status}): falling back to single deletes`);
          ctx.bulkOk = false;
          single.push(...list.slice(i)); // this batch and subsequent batches
          break;
        }
        ctx.log('error', `bulk-delete failed: ${e.message}`);
        stats.failed += batch.length;
        stats.progress += batch.length;
      }
      ctx.save();
    }
  }
  single.sort((a, b) => cmpId(a.id, b.id)); // oldest to newest

  await runPool(single, ctx.speed.concurrency, ctx.shouldStop, async (m) => {
    await ctx.pace();
    if (ctx.shouldStop()) return;
    archiveOnce(ctx, m, 'delete', { via: 'single' });
    try {
      await discordFetch(token, 'DELETE', `/channels/${m.channelId}/messages/${m.id}`, { onRateLimit: ctx.onRateLimit, shouldStop: ctx.shouldStop });
      stats.deleted++;
    } catch (e) {
      if (e.status === 401) throw e;
      if (e.status === 499) return; // cancelled before sending
      if (e.status === 404) { stats.deleted++; ctx.log('info', `Message ${m.id} already deleted`); } // 404 = already gone
      else { stats.failed++; ctx.log('error', `Delete ${m.id} failed: ${e.message}`); }
    }
    stats.progress++;
    ctx.save();
  });
}

// ---- history method (C4): channel pagination at 100/page, local filtering, stream page -> deletion -> cursor.
/** Default for scope all/range; search remains available for content filters, explicit IDs, or method:'search'. */
export function useHistory(params) {
  if (Array.isArray(params.messageIds) && params.messageIds.length) return false;
  if (params.method === 'search' || params.content) return false;
  return !!(params.channelId || params.guildId);
}

/** Text channels in a guild, ordered by position. */
async function listGuildChannels(ctx) {
  await ctx.pace();
  const { data } = await discordFetch(ctx.token, 'GET', `/guilds/${ctx.params.guildId}/channels`, { onRateLimit: ctx.onRateLimit });
  return (data ?? []).filter((c) => GUILD_TEXT_TYPES.has(c.type))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((c) => ({ id: c.id, name: c.name }));
}

async function runHistoryDelete(ctx) {
  const { params } = ctx;
  const max = Number(params.maxMessages) > 0 ? Number(params.maxMessages) : Infinity;
  const lower = toSnowflake(params.after); // exclusive
  const upper = toSnowflake(params.before); // exclusive
  let channels;
  if (params.channelId) channels = [{ id: String(params.channelId), name: params.channelName }];
  else {
    channels = await listGuildChannels(ctx);
    ctx.log('info', `Whole server: ${channels.length} text channels, processed one after another`);
  }
  ctx.log('info', `History method (${HISTORY_PAGE} messages/page, local author + date filter)`);
  let matched = 0; // only global state: no accumulated message array, one page in memory at a time
  for (const ch of channels) {
    if (ctx.shouldStop() || matched >= max) break;
    ctx.bulkOk = true; // bulk deletion permission depends on the channel
    let cursor = upper; // before: lowest ID already visited
    let pages = 0;
    while (!ctx.shouldStop() && matched < max) {
      await ctx.pace();
      let raw;
      try {
        ({ data: raw } = await discordFetch(ctx.token, 'GET', `/channels/${ch.id}/messages`,
          { query: { limit: HISTORY_PAGE, before: cursor }, onRateLimit: ctx.onRateLimit }));
      } catch (e) {
        if (e.status === 401 || params.channelId) throw e;
        ctx.log('warn', `Channel ${ch.name ?? ch.id} skipped: ${e.message}`);
        break;
      }
      if (!Array.isArray(raw) || !raw.length) break;
      pages++;
      const minId = raw.reduce((mn, m) => (cmpId(m.id, mn) < 0 ? m.id : mn), raw[0].id);
      let mine = raw.filter((m) => m.author?.id === ctx.me && isDeletableType(m.type ?? 0)
        && (!lower || cmpId(m.id, lower) > 0) && (!upper || cmpId(m.id, upper) < 0))
        .map((m) => normalizeMessage({ ...m, channel_id: m.channel_id ?? ch.id, guild_id: m.guild_id ?? params.guildId }));
      mine = applyProtection(ctx, mine);
      if (mine.length > max - matched) mine = mine.sort((a, b) => cmpId(b.id, a.id)).slice(0, max - matched);
      if (mine.length) {
        matched += mine.length;
        ctx.stats.total = matched;
        store.updateJob(ctx.jobId, { total: matched });
        await deleteBatch(ctx, mine);
        ctx.save();
        if (ctx.shouldStop()) break; // cursor not advanced: this page will be revisited on resume
      }
      cursor = minId;
      store.updateJob(ctx.jobId, { cursor: JSON.stringify({ channelId: ch.id, before: cursor }) });
      ctx.archived.clear();
      if (raw.length < HISTORY_PAGE || (lower && cmpId(minId, lower) <= 0)) break; // start of channel or boundary crossed
    }
    ctx.log('debug', `Channel ${ch.name ?? ch.id}: ${pages} page(s) scanned`);
  }
}

async function doEdit(ctx, messages) {
  const { params, token, stats } = ctx;
  await runPool(messages, ctx.speed.concurrency, ctx.shouldStop, async (m) => {
    stats.progress++;
    if (m.authorId !== ctx.me) { stats.failed++; ctx.log('warn', `Message ${m.id}: not mine, skipped`); ctx.save(); return; }
    let next;
    try { next = applyEdit(m.content, params.edit); } catch (e) { stats.failed++; ctx.log('error', e.message); ctx.save(); return; }
    if (next === m.content) { ctx.log('debug', `Message ${m.id}: no change`); ctx.save(); return; }
    await ctx.pace();
    archiveOnce(ctx, m, 'edit', { newContent: next });
    try {
      await discordFetch(token, 'PATCH', `/channels/${m.channelId}/messages/${m.id}`, { body: { content: next }, onRateLimit: ctx.onRateLimit, shouldStop: ctx.shouldStop });
      stats.edited++;
    } catch (e) {
      if (e.status === 401) throw e;
      if (e.status === 499) return; // cancelled before sending
      stats.failed++;
      ctx.log('error', `Edit ${m.id} failed: ${e.message}`);
    }
    ctx.save();
  });
}
