// TikTok: remove the user's OWN reposts. No official API: the Electron bridge
// (globalThis.__FORGET_TIKTOK, desktop/tiktok-window.js) runs requests in the user's web session.
// Here: local inventory, selection, archive before removal, serialized queue at a fixed pace, pauses on refusal.
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { insertArchive } from '../discord/store.mjs';

export const TIKTOK_DEFAULTS = { intervalSec: 4, pagePauseMs: 1500, cooldownMs: 15 * 60_000, maxRefusals: 3, maxPerJob: 5000 };
const initialized = new WeakSet();

export function initTikTok(db) {
  if (initialized.has(db)) return;
  // Key (account, video): two accounts can repost the same video. Old schema (key = video):
  // the table is only an inventory cache, so recreate it.
  const pk = db.prepare('PRAGMA table_info(tiktokRepost)').all().filter((c) => c.pk).map((c) => c.name);
  if (pk.length && !pk.includes('account')) db.exec('DROP TABLE tiktokRepost');
  db.exec(`CREATE TABLE IF NOT EXISTS tiktokRepost(account TEXT, id TEXT, author TEXT, desc TEXT, createTime INTEGER, seenAt INTEGER, PRIMARY KEY(account, id));
    CREATE TABLE IF NOT EXISTS tiktokJob(id TEXT PRIMARY KEY, kind TEXT, account TEXT, status TEXT, total INTEGER, done INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0, createdAt INTEGER, finishedAt INTEGER, waitUntil INTEGER, error TEXT);
    UPDATE tiktokJob SET status='interrupted' WHERE status IN ('queued','running','paused','cooldown');`);
  initialized.add(db);
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const videoUrl = (author, id) => `https://www.tiktok.com/@${encodeURIComponent(author || '_')}/video/${id}`;

export function tiktokRouter(db, {
  bridge = () => globalThis.__FORGET_TIKTOK, now = () => Date.now(),
  sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }), defaults = TIKTOK_DEFAULTS,
} = {}) {
  initTikTok(db);
  const app = new Hono();
  const controls = new Map(); // jobId -> { paused, cancelled }
  let account = null; // { secUid, uniqueId, nickname } from the last session check

  const online = () => db.prepare("SELECT value FROM setting WHERE key='privacy.offline'").get()?.value === 'false';
  const hook = () => {
    const b = bridge();
    if (!b || typeof b.listReposts !== 'function') throw fail('Only available in the desktop app.', 501);
    return b;
  };
  const activeJob = () => [...controls.keys()][0] || null;
  const setJob = (id, patch) => {
    const keys = Object.keys(patch);
    db.prepare(`UPDATE tiktokJob SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => patch[k] ?? null), id);
  };
  const getJob = (id) => db.prepare('SELECT * FROM tiktokJob WHERE id=?').get(id);
  // Displayed status: user-requested pause takes priority over cooldown and execution.
  const live = (ctl) => (ctl.paused ? 'paused' : 'running');

  async function session() {
    const ctx = await hook().context();
    if (!ctx?.loggedIn || !ctx.secUid) throw fail('Log in to TikTok in the window opened by Forget, then try again.', 409);
    account = { secUid: ctx.secUid, uniqueId: ctx.uniqueId || null, nickname: ctx.nickname || null };
    return account;
  }
  // Interruptible wait: pause, cancellation, and cooldown period.
  async function hold(ctl, ms) {
    const end = now() + ms;
    while (now() < end) {
      if (ctl.cancelled) throw fail('Operation cancelled', 499);
      await sleep(Math.min(250, end - now()));
    }
    while (ctl.paused && !ctl.cancelled) await sleep(200);
    if (ctl.cancelled) throw fail('Operation cancelled', 499);
  }
  const refused = (r) => r?.httpStatus === 429 || (r && !r.ok);

  function startJob(kind, total, acct, work) {
    if (activeJob()) throw fail('A TikTok operation is already running.', 409);
    const id = randomUUID(), ctl = { paused: false, cancelled: false };
    db.prepare("INSERT INTO tiktokJob(id,kind,account,status,total,createdAt) VALUES (?,?,?,'running',?,?)").run(id, kind, acct, total, now());
    controls.set(id, ctl);
    void (async () => {
      await sleep(0);
      try {
        await work(id, ctl);
        setJob(id, { status: ctl.cancelled ? 'cancelled' : 'done', finishedAt: now(), waitUntil: null });
      } catch (e) {
        setJob(id, { status: e.status === 499 ? 'cancelled' : 'failed', error: e.status === 499 ? null : e.message, finishedAt: now(), waitUntil: null });
      } finally { controls.delete(id); }
    })();
    return id;
  }

  // Inventory: pages of 30, pause between pages, cooldown then stop if TikTok refuses.
  async function scanWork(id, ctl, acct) {
    const b = hook();
    let cursor = '0', seen = 0, refusals = 0;
    const up = db.prepare('INSERT INTO tiktokRepost(id,account,author,desc,createTime,seenAt) VALUES (?,?,?,?,?,?) ON CONFLICT(account,id) DO UPDATE SET author=excluded.author, desc=excluded.desc, seenAt=excluded.seenAt');
    const started = now();
    for (;;) {
      await hold(ctl, 0);
      const r = await b.listReposts({ secUid: acct.secUid, cursor });
      if (refused(r)) {
        if (++refusals >= defaults.maxRefusals) throw fail(`TikTok refused the listing (HTTP ${r?.httpStatus ?? '?'}${r?.statusCode != null ? `, code ${r.statusCode}` : ''}). Try again in an hour.`, 429);
        setJob(id, { status: ctl.paused ? 'paused' : 'cooldown', waitUntil: now() + defaults.cooldownMs });
        await hold(ctl, defaults.cooldownMs);
        setJob(id, { status: live(ctl), waitUntil: null });
        continue;
      }
      refusals = 0;
      for (const it of r.items || []) {
        if (!/^\d{1,25}$/.test(it.id)) continue;
        up.run(it.id, acct.secUid, String(it.author || ''), String(it.desc || ''), Number(it.createTime) || null, now());
        seen++;
      }
      setJob(id, { done: seen, total: seen });
      if (!r.hasMore || !r.cursor || r.cursor === cursor) break;
      cursor = r.cursor;
      await hold(ctl, defaults.pagePauseMs);
    }
    // Reposts missing from the full inventory were removed elsewhere (mobile app): forget them.
    if (!ctl.cancelled) db.prepare('DELETE FROM tiktokRepost WHERE account=? AND seenAt < ?').run(acct.secUid, started);
  }

  async function removeWork(id, ctl, acct, ids, intervalMs) {
    const b = hook();
    let done = 0, failed = 0, refusals = 0;
    const archived = new Set(); // no duplicate archive when an item is retried after cooldown
    const row = db.prepare('SELECT * FROM tiktokRepost WHERE id=? AND account=?');
    const del = db.prepare('DELETE FROM tiktokRepost WHERE account=? AND id=?');
    for (let i = 0; i < ids.length; i++) {
      await hold(ctl, i === 0 ? 0 : intervalMs);
      const it = row.get(ids[i], acct.secUid);
      if (!it) { failed++; setJob(id, { failed }); continue; } // removed in the meantime
      // The TikTok window may have switched accounts: check the session before each removal.
      const ctx = await b.context();
      if (!ctx?.loggedIn || ctx.secUid !== acct.secUid) throw fail('The TikTok session switched accounts (or logged out): operation stopped, nothing removed on another account.', 409);
      if (!archived.has(it.id)) archived.add(it.id) && insertArchive({ platform: 'tiktok', kind: 'repost', messageId: it.id, authorId: it.author, content: it.desc,
        messageCreatedAt: it.createTime ? it.createTime * 1000 : null, action: 'unrepost', meta: { url: videoUrl(it.author, it.id), archiveScope: 'text-and-metadata' } });
      const r = await b.removeRepost(it.id);
      if (r?.ok) { done++; refusals = 0; del.run(acct.secUid, it.id); setJob(id, { done }); continue; }
      if (++refusals >= defaults.maxRefusals) {
        throw fail(`TikTok refused the removals (HTTP ${r?.httpStatus ?? '?'}${r?.statusCode != null ? `, code ${r.statusCode}` : ''}). Operation stopped: try again in an hour.`, 429);
      }
      // Refusal or rate limit: cooldown, then retry the same item.
      setJob(id, { status: ctl.paused ? 'paused' : 'cooldown', waitUntil: now() + defaults.cooldownMs });
      await hold(ctl, defaults.cooldownMs);
      setJob(id, { status: live(ctl), waitUntil: null });
      i--;
    }
    if (failed) setJob(id, { failed });
  }

  app.onError((e, c) => c.json({ error: e.message }, [400, 404, 409, 429, 499, 501, 502].includes(e.status) ? e.status : 500));

  app.get('/status', (c) => {
    const b = bridge();
    const job = activeJob();
    return c.json({
      available: !!(b && typeof b.listReposts === 'function'), online: online(), windowOpen: !!b?.isOpen?.(),
      account: account && { uniqueId: account.uniqueId, nickname: account.nickname },
      count: account ? db.prepare('SELECT COUNT(*) n FROM tiktokRepost WHERE account=?').get(account.secUid).n : 0,
      activeJob: job, defaults: { intervalSec: defaults.intervalSec, cooldownMin: Math.round(defaults.cooldownMs / 60000) },
    });
  });
  app.post('/window', async (c) => {
    if (!online()) throw fail('Turn off offline mode in Settings > Privacy.', 409);
    await hook().open();
    return c.json({ opened: true });
  });
  app.post('/session', async (c) => c.json(await session().then((a) => ({ uniqueId: a.uniqueId, nickname: a.nickname }))));
  app.post('/scan', async (c) => {
    if (!online()) throw fail('Turn off offline mode in Settings > Privacy.', 409);
    const acct = await session();
    return c.json({ jobId: startJob('scan', 0, acct.secUid, (id, ctl) => scanWork(id, ctl, acct)) });
  });
  app.get('/reposts', (c) => {
    if (!account) return c.json({ items: [], total: 0 });
    const q = String(c.req.query('q') || '').toLowerCase().slice(0, 200), author = String(c.req.query('author') || '').replace(/^@/, '').toLowerCase().slice(0, 100);
    const limit = Math.min(Math.max(parseInt(c.req.query('limit'), 10) || 500, 1), 5000);
    const rows = db.prepare('SELECT * FROM tiktokRepost WHERE account=? ORDER BY seenAt DESC, rowid').all(account.secUid)
      .filter((r) => (!q || r.desc.toLowerCase().includes(q)) && (!author || r.author.toLowerCase().includes(author)));
    return c.json({ total: rows.length, items: rows.slice(0, limit).map((r) => ({ id: r.id, author: r.author, desc: r.desc, createTime: r.createTime, url: videoUrl(r.author, r.id) })) });
  });
  app.post('/jobs', async (c) => {
    if (!online()) throw fail('Turn off offline mode in Settings > Privacy.', 409);
    const b = await c.req.json().catch(() => ({}));
    if (b.confirm !== true) throw fail('Confirmation requise.');
    const acct = await session();
    let ids = [...new Set(Array.isArray(b.ids) ? b.ids.map(String) : [])];
    if (b.all === true) ids = db.prepare('SELECT id FROM tiktokRepost WHERE account=? ORDER BY seenAt DESC, rowid').all(acct.secUid).map((r) => r.id);
    if (!ids.length || ids.length > defaults.maxPerJob || ids.some((id) => !/^\d{1,25}$/.test(id))) throw fail(`Select 1 to ${defaults.maxPerJob} reposts.`);
    const known = db.prepare('SELECT id FROM tiktokRepost WHERE account=? AND id=?');
    if (ids.some((id) => !known.get(acct.secUid, id))) throw fail('Run the inventory again: some selected items are unknown.');
    const sec = Number(b.intervalSec);
    const intervalMs = Math.round((Number.isFinite(sec) ? Math.min(60, Math.max(2, sec)) : defaults.intervalSec) * 1000);
    return c.json({ jobId: startJob('remove', ids.length, acct.secUid, (id, ctl) => removeWork(id, ctl, acct, ids, intervalMs)) });
  });
  app.get('/jobs', (c) => c.json(db.prepare('SELECT * FROM tiktokJob ORDER BY createdAt DESC, rowid DESC LIMIT 20').all()));
  app.post('/jobs/:id/:action', (c) => {
    const id = c.req.param('id'), action = c.req.param('action'), ctl = controls.get(id);
    if (!['pause', 'resume', 'cancel'].includes(action)) throw fail('Action inconnue');
    if (!ctl) throw fail('Active operation not found', 404);
    if (action === 'cancel') ctl.cancelled = true;
    else {
      ctl.paused = action === 'pause';
      const j = getJob(id);
      const cooling = j?.waitUntil && j.waitUntil > now();
      setJob(id, { status: ctl.paused ? 'paused' : cooling ? 'cooldown' : 'running' });
    }
    return c.json({ ok: true });
  });
  return app;
}
