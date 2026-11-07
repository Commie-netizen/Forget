// Jobs de suppression / édition en masse : asynchrones, annulables, progression persistée.
import * as store from './store.mjs';
import { discordFetch, sleep } from './http.mjs';
import { collectMessages } from './search.mjs';
import { archiveMessage } from './archive.mjs';
import { normalizeMessage, toSnowflake, cmpId, BULK_MAX_AGE_MS, protectionFilter } from './util.mjs';

export const HISTORY_PAGE = 100; // taille de page de GET /channels/{id}/messages
const GUILD_TEXT_TYPES = new Set([0, 5]); // salons texte, annonces
const isDeletableType = (t) => t === 0 || (t >= 6 && t <= 21); // messages/réponses ; pas les évènements système

const running = new Map(); // jobId -> Promise (permet l'attente en test et l'arrêt propre)

/** Modes de vitesse : safe 900 ms/1, fast 300 ms/2, turbo 120 ms/3, custom (délai >= 150, concurrence 1-4). */
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

/** Espace les débuts de requêtes d'au moins delayMs (partagé entre les "lanes" concurrentes). */
export function makePacer(delayMs) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const slot = Math.max(now, next);
    next = slot + delayMs;
    if (slot > now) await sleep(slot - now);
  };
}

/** Calcule le nouveau contenu d'un message selon l'opération d'édition. */
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
    default: throw new Error(`mode d'édition inconnu : ${edit.mode}`);
  }
}

export function validateEdit(edit) {
  if (!edit || typeof edit !== 'object') return 'edit requis';
  if (edit.mode === 'replace') {
    if (!edit.find) return 'edit.find requis';
    if (String(edit.find).length > 500) return 'edit.find trop long (500 caractères max.)'; // limite le risque de ReDoS
    if (edit.regex) { try { new RegExp(String(edit.find), 'g'); } catch { return 'expression régulière invalide'; } }
    return null;
  }
  if (['append', 'prepend', 'set'].includes(edit.mode)) return typeof edit.text === 'string' ? null : 'edit.text requis';
  return 'edit.mode invalide (replace|append|prepend|set)';
}

function startJob(kind, params) {
  const jobId = store.createJob(kind, params);
  // Démarrage différé : la requête HTTP répond immédiatement avec jobId.
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
/** Arrêt du serveur : demande l'annulation de tous les jobs actifs. */
export function cancelAllJobs() {
  for (const id of running.keys()) store.requestCancel(id);
}
export async function waitAllJobs() {
  await Promise.all([...running.values()]);
}

/** Exécute `worker` sur chaque item avec N lanes ; chaque lane vérifie l'annulation à chaque itération. */
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
    if (!token) throw new Error('Discord non connecté');
    store.updateJob(jobId, { status: 'running', startedAt: Date.now() });
    const speed = resolveSpeed(params.speed);
    const stats = { progress: 0, deleted: 0, edited: 0, failed: 0 };
    const ctx = {
      jobId, token: token.token, me: token.userId, params, speed, stats,
      pace: makePacer(speed.delayMs),
      shouldStop: () => store.isCancelRequested(jobId),
      log: (level, message, meta) => store.addLog(jobId, level, message, meta),
      onRateLimit: (i) => store.addLog(jobId, 'warn', `429 : attente ${i.retryAfterMs} ms (tentative ${i.attempt})`, i),
      save: () => store.updateJob(jobId, stats),
      archived: new Set(),
      bulkOk: params.allowBulk === false ? false : undefined,
      protect: protectionFilter(params),
    };
    ctx.log('info', `Job ${kind} démarré (vitesse ${speed.mode} : ${speed.delayMs} ms, concurrence ${speed.concurrency})`);
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
    ctx.log('info', cancelled ? 'Job annulé' : 'Job terminé', stats);
  } catch (e) {
    store.addLog(jobId, 'error', e.message);
    store.updateJob(jobId, { status: 'failed', error: e.message, finishedAt: Date.now() });
  }
}

/** Liste les messages cibles : ids fournis (récupérés un par un) ou recherche de ses propres messages. */
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
        // around=<id>&limit=1 renvoie le message ciblé (l'accès direct est réservé aux bots)
        const { data } = await discordFetch(token, 'GET', `/channels/${params.channelId}/messages`,
          { query: { around: id, limit: params.verifyPages ? 100 : 1 }, onRateLimit: ctx.onRateLimit, shouldStop: ctx.shouldStop });
        for (const raw of data ?? []) {
          if (!wanted.has(raw.id) || seen.has(raw.id)) continue;
          seen.add(raw.id);
          if (raw.author?.id === ctx.me) out.push(normalizeMessage({ ...raw, channel_id: raw.channel_id ?? params.channelId, guild_id: raw.guild_id ?? params.guildId }));
          else { ctx.stats.failed++; ctx.log('warn', `Message ${raw.id} : auteur différent, ignoré`); }
        }
        if (!seen.has(id)) {
          seen.add(id); ctx.log('warn', `Message ${id} introuvable, ignoré`);
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
  ctx.log('info', 'Recherche de mes messages (pagination par 25)');
  const found = await collectMessages(token, {
    guildId: params.guildId, channelId: params.channelId, authorId: ctx.me, content: params.content || undefined,
    minId: toSnowflake(params.after), maxId: toSnowflake(params.before),
  }, {
    max, shouldStop: ctx.shouldStop, pace: ctx.pace, onRateLimit: ctx.onRateLimit,
    onPage: (count, total) => ctx.log('debug', `${count} messages collectés (total Discord ${total})`),
  });
  return applyProtection(ctx, found);
}

/** Retire les messages protégés (épinglés, mots exclus...) et les compte comme ignorés. */
function applyProtection(ctx, messages) {
  if (!ctx.protect) return messages;
  const kept = messages.filter(ctx.protect);
  const skipped = messages.length - kept.length;
  if (skipped) {
    ctx.stats.skipped = (ctx.stats.skipped || 0) + skipped;
    ctx.log('info', `${skipped} message(s) protégé(s) par les filtres, conservé(s)`);
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

/**
 * Supprime un lot : bulk-delete (< 14 j, par salon, lots de 100) puis suppression unitaire
 * (concurrence = speed.concurrency, pacer global). Archive AVANT l'action ; met à jour stats/progression.
 * `ctx.bulkOk` passe à false si Discord refuse le bulk (DM, permission) -> repli unitaire.
 */
async function deleteBatch(ctx, messages) {
  const { params, token, stats } = ctx;
  const cutoff = Date.now() - BULK_MAX_AGE_MS;
  const single = messages.filter((m) => m.timestamp <= cutoff || ctx.bulkOk === false); // anciens : unitaire obligatoire
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
      batch.forEach((m) => archiveOnce(ctx, m, 'delete', { via: 'bulk' })); // archive AVANT l'action
      try {
        await discordFetch(token, 'POST', `/channels/${channelId}/messages/bulk-delete`,
          { body: { messages: batch.map((m) => m.id) }, onRateLimit: ctx.onRateLimit, shouldStop: ctx.shouldStop });
        stats.deleted += batch.length;
        stats.progress += batch.length;
      } catch (e) {
        if (e.status === 401) throw e;
        if (e.status === 499) return; // annulé pendant l'attente du quota : rien n'a été envoyé
        if ([400, 403, 404, 405].includes(e.status)) {
          ctx.log('warn', `bulk-delete refusé (${e.status}) : repli sur suppression unitaire`);
          ctx.bulkOk = false;
          single.push(...list.slice(i)); // ce lot et les suivants
          break;
        }
        ctx.log('error', `bulk-delete échoué : ${e.message}`);
        stats.failed += batch.length;
        stats.progress += batch.length;
      }
      ctx.save();
    }
  }
  single.sort((a, b) => cmpId(a.id, b.id)); // du plus ancien au plus récent

  await runPool(single, ctx.speed.concurrency, ctx.shouldStop, async (m) => {
    await ctx.pace();
    if (ctx.shouldStop()) return;
    archiveOnce(ctx, m, 'delete', { via: 'single' });
    try {
      await discordFetch(token, 'DELETE', `/channels/${m.channelId}/messages/${m.id}`, { onRateLimit: ctx.onRateLimit, shouldStop: ctx.shouldStop });
      stats.deleted++;
    } catch (e) {
      if (e.status === 401) throw e;
      if (e.status === 499) return; // annulé avant l'envoi
      if (e.status === 404) { stats.deleted++; ctx.log('info', `Message ${m.id} déjà supprimé`); } // 404 = déjà parti
      else { stats.failed++; ctx.log('error', `Suppression ${m.id} échouée : ${e.message}`); }
    }
    stats.progress++;
    ctx.save();
  });
}

// ---- méthode historique (C4) : pagination du salon 100/page, filtre local, streaming page -> suppression -> curseur.
/** Défaut pour scope all/range ; la recherche reste pour les filtres de contenu, les ids explicites ou method:'search'. */
export function useHistory(params) {
  if (Array.isArray(params.messageIds) && params.messageIds.length) return false;
  if (params.method === 'search' || params.content) return false;
  return !!(params.channelId || params.guildId);
}

/** Salons textuels d'une guilde, par position. */
async function listGuildChannels(ctx) {
  await ctx.pace();
  const { data } = await discordFetch(ctx.token, 'GET', `/guilds/${ctx.params.guildId}/channels`, { onRateLimit: ctx.onRateLimit });
  return (data ?? []).filter((c) => GUILD_TEXT_TYPES.has(c.type))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((c) => ({ id: c.id, name: c.name }));
}

async function runHistoryDelete(ctx) {
  const { params } = ctx;
  const max = Number(params.maxMessages) > 0 ? Number(params.maxMessages) : Infinity;
  const lower = toSnowflake(params.after); // exclusif
  const upper = toSnowflake(params.before); // exclusif
  let channels;
  if (params.channelId) channels = [{ id: String(params.channelId), name: params.channelName }];
  else {
    channels = await listGuildChannels(ctx);
    ctx.log('info', `Serveur entier : ${channels.length} salons textuels, traités l'un après l'autre`);
  }
  ctx.log('info', `Méthode historique (${HISTORY_PAGE} messages/page, filtre local auteur + dates)`);
  let matched = 0; // seul état global : aucun tableau de messages cumulé, une page en mémoire à la fois
  for (const ch of channels) {
    if (ctx.shouldStop() || matched >= max) break;
    ctx.bulkOk = true; // la permission bulk dépend du salon
    let cursor = upper; // `before` : plus petit id déjà parcouru
    let pages = 0;
    while (!ctx.shouldStop() && matched < max) {
      await ctx.pace();
      let raw;
      try {
        ({ data: raw } = await discordFetch(ctx.token, 'GET', `/channels/${ch.id}/messages`,
          { query: { limit: HISTORY_PAGE, before: cursor }, onRateLimit: ctx.onRateLimit }));
      } catch (e) {
        if (e.status === 401 || params.channelId) throw e;
        ctx.log('warn', `Salon ${ch.name ?? ch.id} ignoré : ${e.message}`);
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
        if (ctx.shouldStop()) break; // curseur non avancé : la page serait revue à la reprise
      }
      cursor = minId;
      store.updateJob(ctx.jobId, { cursor: JSON.stringify({ channelId: ch.id, before: cursor }) });
      ctx.archived.clear();
      if (raw.length < HISTORY_PAGE || (lower && cmpId(minId, lower) <= 0)) break; // début du salon ou borne dépassée
    }
    ctx.log('debug', `Salon ${ch.name ?? ch.id} : ${pages} page(s) parcourue(s)`);
  }
}

async function doEdit(ctx, messages) {
  const { params, token, stats } = ctx;
  await runPool(messages, ctx.speed.concurrency, ctx.shouldStop, async (m) => {
    stats.progress++;
    if (m.authorId !== ctx.me) { stats.failed++; ctx.log('warn', `Message ${m.id} : pas le mien, ignoré`); ctx.save(); return; }
    let next;
    try { next = applyEdit(m.content, params.edit); } catch (e) { stats.failed++; ctx.log('error', e.message); ctx.save(); return; }
    if (next === m.content) { ctx.log('debug', `Message ${m.id} : aucun changement`); ctx.save(); return; }
    await ctx.pace();
    archiveOnce(ctx, m, 'edit', { newContent: next });
    try {
      await discordFetch(token, 'PATCH', `/channels/${m.channelId}/messages/${m.id}`, { body: { content: next }, onRateLimit: ctx.onRateLimit, shouldStop: ctx.shouldStop });
      stats.edited++;
    } catch (e) {
      if (e.status === 401) throw e;
      if (e.status === 499) return; // annulé avant l'envoi
      stats.failed++;
      ctx.log('error', `Édition ${m.id} échouée : ${e.message}`);
    }
    ctx.save();
  });
}
