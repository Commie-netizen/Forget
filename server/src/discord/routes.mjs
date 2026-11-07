// Routeur Hono monté sur /api/discord.
import { Hono } from 'hono';
import * as store from './store.mjs';
import { discordFetch, DiscordError, rateLimitStatus } from './http.mjs';
import { maskToken, normalizeMessage, protectionParams, protectionFilter, toSnowflake } from './util.mjs';
import { searchPage } from './search.mjs';
import { startDeleteJob, startEditJob, cancelJob, validateEdit, resolveSpeed } from './bulk.mjs';
import { startPurge, runPurgeNow, cancelPurge } from './purge.mjs';
import { toCsv } from './archive.mjs';
import { startDisappearing, stopDisappearing, disappearingStatus, SCOPES } from './gateway.mjs';

const publicUser = (u) => ({ id: u.id, username: u.username, avatar: u.avatar ?? null });

// Appel REST avec le token stocké.
const call = (method, path, opts) => discordFetch(store.getToken().token, method, path, opts);

// Garde : 409 si aucun token n'est stocké.
const needConn = async (c, next) => {
  if (!store.getToken()) return c.json({ error: 'Discord non connecté' }, 409);
  await next();
};

function errorResponse(c, e) {
  if (e instanceof DiscordError) {
    const st = [401, 403, 404].includes(e.status) ? e.status : 502;
    return c.json({ error: e.message, discordStatus: e.status }, st);
  }
  return c.json({ error: e.message || 'erreur interne' }, e.status === 400 ? 400 : 500);
}
const wrap = (fn) => async (c) => { try { return await fn(c); } catch (e) { return errorResponse(c, e); } };
const body = (c) => c.req.json().catch(() => ({}));
const bad = (c, error) => c.json({ error }, 400);

function status() {
  const t = store.getToken();
  const out = { connected: !!t, disappearing: disappearingStatus() };
  if (t) {
    out.user = { id: t.userId, username: t.username, avatar: store.getAvatar() };
    out.tokenMasked = maskToken(t.token);
  }
  return out;
}

// Paramètres communs aux jobs : cible + vitesse.
function jobParams(b) {
  const p = {
    channelId: b.channelId ? String(b.channelId) : undefined, guildId: b.guildId ? String(b.guildId) : undefined,
    channelName: b.channelName, guildName: b.guildName,
    messageIds: Array.isArray(b.messageIds) ? b.messageIds.map(String) : undefined,
    before: b.before, after: b.after, maxMessages: b.maxMessages,
    content: typeof b.content === 'string' && b.content ? b.content : undefined,
    method: b.method === 'search' || b.method === 'history' ? b.method : undefined, speed: b.speed ?? { mode: 'safe' },
  };
  p.speed = resolveSpeed(p.speed); // valeurs effectives persistées
  Object.assign(p, protectionParams(b));
  return p;
}

// Valide un token via /users/@me, le stocke (chiffré si cipher) et relance le mode disparition si actif.
async function connectWithToken(c, token) {
  let user;
  try {
    user = (await discordFetch(token, 'GET', '/users/@me')).data;
  } catch (e) {
    if (e instanceof DiscordError && e.status === 401) return c.json({ error: 'Token invalide' }, 401);
    throw e;
  }
  store.setToken({ token, userId: user.id, username: user.username, avatar: user.avatar });
  if (store.getDisappearing().enabled) startDisappearing();
  return c.json({ ok: true, user: publicUser(user) });
}
let loginInProgress = false;

export function buildDiscordRouter() {
  const app = new Hono();

  app.get('/status', wrap((c) => c.json(status())));
  app.get('/rate-limits', wrap((c) => c.json(rateLimitStatus(store.getToken()?.token))));

  app.post('/token', wrap(async (c) => {
    const raw = (await body(c)).token;
    const token = typeof raw === 'string' ? raw.trim().replace(/^"+|"+$/g, '') : '';
    if (!token) return bad(c, 'token requis');
    return connectWithToken(c, token);
  }));

  // C1 : fenêtre de connexion fournie par Electron (hook global) ; 501 hors application de bureau.
  app.post('/login-window', wrap(async (c) => {
    const hook = globalThis.__FORGET_LOGIN_WINDOW;
    if (typeof hook !== 'function') return c.json({ error: "Connexion intégrée disponible dans l'application de bureau uniquement" }, 501);
    if (loginInProgress) return c.json({ error: 'Une fenêtre de connexion est déjà ouverte' }, 409);
    loginInProgress = true;
    let res;
    try { res = await hook(); } finally { loginInProgress = false; }
    if (res?.cancelled) return c.json({ error: 'Connexion annulée', cancelled: true }, 400);
    if (res?.error || typeof res?.token !== 'string' || !res.token.trim()) {
      return c.json({ error: String(res?.error || 'Aucun token reçu de la fenêtre de connexion') }, 500);
    }
    return connectWithToken(c, res.token.trim().replace(/^"+|"+$/g, ''));
  }));

  app.delete('/token', wrap((c) => {
    stopDisappearing();
    store.clearToken();
    return c.json({ ok: true });
  }));

  app.get('/me', needConn, wrap(async (c) => {
    const [me, guilds, dms] = await Promise.all([
      call('GET', '/users/@me'), call('GET', '/users/@me/guilds'), call('GET', '/users/@me/channels'),
    ]);
    return c.json({ user: publicUser(me.data), guildsCount: guilds.data.length, dmCount: dms.data.length });
  }));

  app.get('/guilds', needConn, wrap(async (c) => {
    const guilds = (await call('GET', '/users/@me/guilds')).data;
    // En parallèle : chaque guilde a son propre quota Discord, le limiteur partagé régule la cadence.
    const out = await Promise.all(guilds.map(async (g) => {
      let channels = [];
      try {
        channels = (await call('GET', `/guilds/${g.id}/channels`)).data.map((ch) => ({
          id: ch.id, name: ch.name, type: ch.type, parentId: ch.parent_id ?? null, position: ch.position ?? 0,
        }));
      } catch (e) {
        if (e.status === 401) throw e; // autre erreur : guilde listée sans salons
      }
      return { id: g.id, name: g.name, icon: g.icon ?? null, channels };
    }));
    return c.json(out);
  }));

  app.get('/dms', needConn, wrap(async (c) => {
    const dms = (await call('GET', '/users/@me/channels')).data;
    return c.json(dms.map((d) => ({
      id: d.id,
      name: d.name || (d.recipients ?? []).map((r) => r.username).join(', '),
      type: d.type,
      recipients: (d.recipients ?? []).map((r) => ({ id: r.id, username: r.username })),
    })));
  }));

  app.get('/channels/:channelId/messages', needConn, wrap(async (c) => {
    const limit = Math.min(Math.max(parseInt(c.req.query('limit'), 10) || 50, 1), 100);
    const { data } = await call('GET', `/channels/${c.req.param('channelId')}/messages`, {
      query: { before: c.req.query('before'), after: c.req.query('after'), limit },
    });
    return c.json(data.map(normalizeMessage));
  }));

  app.get('/search', needConn, wrap(async (c) => {
    const q = c.req.query();
    if (!q.guildId && !q.channelId) return bad(c, 'guildId ou channelId requis');
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
    const page = await searchPage(store.getToken().token, {
      guildId: q.guildId, channelId: q.channelId, authorId: q.authorId, content: q.content,
      minId: q.minId, maxId: q.maxId, offset,
    });
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 25, 1), 25);
    const messages = page.messages.slice(0, limit);
    return c.json({ total: page.total, offset, nextOffset: offset + page.messages.length < page.total ? offset + 25 : null, messages });
  }));

  app.post('/jobs/delete', needConn, wrap(async (c) => {
    const b = await body(c);
    if (!b.channelId && !b.guildId) return bad(c, 'channelId ou guildId requis');
    return c.json({ jobId: startDeleteJob(jobParams(b)) });
  }));

  // Aperçu avant suppression : une seule requête de recherche (aucune action), estimation + exemples.
  app.post('/jobs/preview', needConn, wrap(async (c) => {
    const b = await body(c);
    if (!b.channelId && !b.guildId) return bad(c, 'channelId ou guildId requis');
    const p = jobParams(b);
    if (p.messageIds?.length) return c.json({ total: new Set(p.messageIds).size, exact: true, sample: [], filtered: false });
    const t = store.getToken();
    const page = await searchPage(t.token, {
      guildId: p.guildId, channelId: p.channelId, authorId: t.userId, content: p.content,
      minId: toSnowflake(p.after), maxId: toSnowflake(p.before), offset: 0,
    });
    const keep = protectionFilter(p);
    const sample = (keep ? page.messages.filter(keep) : page.messages).slice(0, 8);
    return c.json({ total: page.total, exact: false, filtered: !!keep, sample });
  }));

  app.post('/jobs/edit', needConn, wrap(async (c) => {
    const b = await body(c);
    if (!b.channelId) return bad(c, 'channelId requis');
    const err = validateEdit(b.edit);
    if (err) return bad(c, err);
    return c.json({ jobId: startEditJob({ ...jobParams(b), edit: b.edit }) });
  }));

  // Lecture locale : fonctionne sans token.
  // C3 : jobs en cours (queued/running) avec progression, pour la bannière globale.
  app.get('/jobs/active', wrap((c) => {
    const jobs = store.listActiveJobs().map((j) => ({
      id: j.id, kind: j.kind, status: j.status, progress: j.progress ?? 0, total: j.total ?? 0,
      deleted: j.deleted ?? 0, edited: j.edited ?? 0, failed: j.failed ?? 0, startedAt: j.startedAt ?? j.createdAt ?? null,
    }));
    return c.json({ jobs, running: jobs.length });
  }));
  app.get('/jobs', wrap((c) => c.json(store.listJobs())));
  app.get('/jobs/:id', wrap((c) => {
    const job = store.getJob(c.req.param('id'));
    if (!job) return c.json({ error: 'job introuvable' }, 404);
    return c.json({ ...job, logs: store.getLogs(job.id) });
  }));
  app.post('/jobs/:id/cancel', wrap((c) => {
    const job = store.getJob(c.req.param('id'));
    if (!job) return c.json({ error: 'job introuvable' }, 404);
    cancelJob(job.id);
    return c.json({ ok: true });
  }));

  // Purges reprenables (lecture locale sans token ; création et exécution manuelle exigent la connexion)
  app.post('/purges', needConn, wrap(async (c) => {
    const b = await body(c);
    if (!b.channelId) return bad(c, 'channelId requis');
    return c.json({ id: startPurge(b) });
  }));
  app.get('/purges', needConn, wrap((c) => c.json(store.listPurges())));
  app.get('/purges/:id', needConn, wrap((c) => {
    const p = store.getPurge(c.req.param('id'));
    return p ? c.json(p) : c.json({ error: 'purge introuvable' }, 404);
  }));
  app.post('/purges/:id/run', needConn, wrap((c) => {
    const r = runPurgeNow(c.req.param('id'));
    return r.error ? c.json({ error: r.error }, r.status) : c.json({ ok: true });
  }));
  app.delete('/purges/:id', wrap((c) => (cancelPurge(c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'purge introuvable' }, 404))));

  app.get('/archive/export', wrap((c) => {
    const rows = store.queryArchive({ ...c.req.query(), limit: 100000 });
    if (c.req.query('format') === 'csv') {
      return c.body(toCsv(rows), 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="discord-archive.csv"' });
    }
    return c.body(JSON.stringify(rows, null, 2), 200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="discord-archive.json"' });
  }));
  app.get('/archive', wrap((c) => c.json(store.queryArchive(c.req.query()))));

  app.get('/disappearing', wrap((c) => c.json(disappearingStatus())));
  app.patch('/disappearing', wrap(async (c) => {
    const b = await body(c);
    const patch = {};
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    if (b.delaySec !== undefined) {
      const d = Number(b.delaySec);
      if (!Number.isFinite(d) || d < 1) return bad(c, 'delaySec doit être >= 1');
      patch.delaySec = Math.min(Math.floor(d), 2_000_000); // setTimeout plafonné ~24 j
    }
    if (b.scope !== undefined) {
      if (!SCOPES.includes(b.scope)) return bad(c, `scope invalide (${SCOPES.join('|')})`);
      patch.scope = b.scope;
    }
    if (b.guildIds !== undefined) {
      if (!Array.isArray(b.guildIds)) return bad(c, 'guildIds doit être un tableau');
      patch.guildIds = b.guildIds.map(String);
    }
    if (patch.enabled && !store.getToken()) return c.json({ error: 'Discord non connecté' }, 409);
    const next = store.setDisappearing(patch);
    if (next.enabled) startDisappearing(); else stopDisappearing();
    return c.json(disappearingStatus());
  }));

  return app;
}
