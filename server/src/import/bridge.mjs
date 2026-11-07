import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { stat, readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { zipEntries } from './zipread.mjs';
import * as store from '../discord/store.mjs';
import { startDeleteJob, waitForJob, cancelJob } from '../discord/bulk.mjs';

const yieldTurn = () => new Promise(r => setImmediate(r));
const active = new Map();
const ID = /^\d{1,22}$/;
const cleanId = v => (typeof v === 'number' && !Number.isSafeInteger(v)) || !ID.test(String(v ?? '')) ? null : String(v);
// Discord snowflakes exceed JS integer precision. Keep the original JSON token.
export const parseJson = text => JSON.parse(text, (key, value, context) => {
  if (/^(id|mid|cid|channel_id|guild_id)$/i.test(key) && typeof value === 'number') {
    if (context?.source && /^\d+$/.test(context.source)) return context.source;
    if (!Number.isSafeInteger(value)) throw new Error('Identifiant JSON hors précision');
  }
  return value;
});
const timestamp = v => {
  const n = Number(v);
  if (v != null && v !== '' && Number.isFinite(n)) return n < 1e11 ? n * 1000 : n;
  const s = String(v ?? '');
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : null;
};

export function initImport(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS forgetImport(id TEXT PRIMARY KEY, source TEXT, status TEXT, processed INTEGER DEFAULT 0, errors INTEGER DEFAULT 0, error TEXT, createdAt INTEGER);
    CREATE TABLE IF NOT EXISTS forgetImportChannel(batchId TEXT, cid TEXT, name TEXT, kind TEXT, PRIMARY KEY(batchId,cid));
    CREATE TABLE IF NOT EXISTS forgetImportMessage(batchId TEXT, mid TEXT, cid TEXT, ts INTEGER, content TEXT, PRIMARY KEY(batchId,mid));
    CREATE INDEX IF NOT EXISTS forgetImportChannelMessages ON forgetImportMessage(batchId,cid,ts);
    CREATE TABLE IF NOT EXISTS forgetImportPlan(id TEXT PRIMARY KEY, batchId TEXT, status TEXT, count INTEGER, createdAt INTEGER, jobIds TEXT DEFAULT '[]', error TEXT);
    CREATE TABLE IF NOT EXISTS forgetImportPlanItem(planId TEXT, mid TEXT, cid TEXT, ts INTEGER, content TEXT, PRIMARY KEY(planId,mid));`);
  db.exec("UPDATE forgetImport SET status='interrupted' WHERE status='importing'; UPDATE forgetImportPlan SET status='interrupted' WHERE status='running';");
}

export function parseCsv(text) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n')) {
      row.push(value.replace(/\r$/, '')); value = '';
      if (c === '\n') { rows.push(row); row = []; }
    } else value += c;
  }
  if (quoted) throw new Error('CSV : guillemet non fermé');
  if (value || row.length) { row.push(value.replace(/\r$/, '')); rows.push(row); }
  const headers = (rows.shift() || []).map(s => s.replace(/^\uFEFF/, '').trim().toLowerCase());
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

export async function importSource(db, batchId, source) {
  let errors = 0, processed = 0;
  const addChannel = db.prepare('INSERT INTO forgetImportChannel VALUES (?,?,?,?) ON CONFLICT(batchId,cid) DO UPDATE SET name=excluded.name,kind=excluded.kind');
  const add = db.prepare('INSERT OR IGNORE INTO forgetImportMessage VALUES (?,?,?,?,?)');
  const progress = () => db.prepare('UPDATE forgetImport SET processed=?,errors=? WHERE id=?').run(processed, errors, batchId);
  function message(row, cid) {
    const mid = cleanId(row.ID ?? row.id ?? row.mid), ts = timestamp(row.Timestamp ?? row.timestamp ?? row.ts);
    if (!mid || !cid || ts === null) { errors++; return; }
    add.run(batchId, mid, cid, ts, String(row.Contents ?? row.contents ?? row.content ?? ''));
    processed++;
  }
  async function consume(name, bytes) {
    const match = name.replaceAll('\\', '/').match(/(?:^|\/)messages\/c?(\d+)\/(channel\.json|messages\.json|messages\.csv)$/i);
    if (!match) return;
    const cid = cleanId(match[1]);
    if (!cid) { errors++; return; }
    const filename = match[2].toLowerCase();
    db.prepare('INSERT OR IGNORE INTO forgetImportChannel VALUES (?,?,?,?)').run(batchId, cid, `Conversation ${cid}`, 'unknown');
    try {
      const text = Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '');
      if (filename === 'channel.json') {
        const c = parseJson(text);
        const kind = c.guild || c.guild_id || c.type === 0 || c.type === 'GUILD_TEXT' ? 'guild' : [1,3,'DM','GROUP_DM'].includes(c.type) ? 'dm' : 'unknown';
        addChannel.run(batchId, cid, String(c.name || `Conversation ${cid}`), kind);
      } else {
        const rows = filename.endsWith('.csv') ? parseCsv(text) : parseJson(text);
        if (!Array.isArray(rows)) throw new Error('Liste de messages attendue');
        for (let i = 0; i < rows.length; i++) {
          message(rows[i], cid);
          if (i % 1000 === 999) { progress(); await yieldTurn(); }
        }
      }
    } catch { errors++; }
    progress(); await yieldTurn();
  }
  try {
    const info = await stat(source);
    if (info.isFile() && ['.db', '.sqlite', '.sqlite3'].includes(extname(source).toLowerCase())) {
      const engine = new DatabaseSync(source, { readOnly: true });
      try {
        for (const c of engine.prepare('SELECT cid,name,kind FROM channel').iterate()) {
          const cid = cleanId(c.cid); if (cid) addChannel.run(batchId, cid, String(c.name || cid), c.kind === 'dm' ? 'dm' : c.kind === 'guild' ? 'guild' : 'unknown');
        }
        for (const m of engine.prepare('SELECT mid,cid,ts,content FROM message').iterate()) {
          message(m, cleanId(m.cid));
          if (processed % 1000 === 0) { progress(); await yieldTurn(); }
        }
      } finally { engine.close(); }
    } else if (info.isDirectory()) {
      async function walk(dir, depth = 0) {
        if (depth > 5) return;
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const file = join(dir, e.name);
          if (e.isDirectory()) await walk(file, depth + 1);
          else if (e.isFile() && /(?:channel|messages)\.(?:json|csv)$/i.test(e.name)) {
            if ((await stat(file)).size > 64 * 1024 * 1024) throw new Error('Fichier de conversation supérieur à 64 Mo : utilisez la base Forget Engine.');
            await consume(file, await readFile(file));
          }
        }
      }
      await walk(source);
    } else if (extname(source).toLowerCase() === '.zip') {
      // Seuls les fichiers de messages sont décompressés, un à la fois, à mémoire bornée (zipread.mjs).
      const wanted = (name) => /(?:^|\/)messages\/c?\d+\/(?:channel\.json|messages\.(?:json|csv))$/i.test(name.replaceAll('\\', '/'));
      for await (const entry of zipEntries(source, wanted, { tooBig: 'Export trop volumineux : utilisez la base Forget Engine.' })) {
        await consume(entry.name, entry.data);
      }
    } else throw new Error('Choisissez un export ZIP, un dossier ou une base Forget Engine.');
    progress();
    const count = db.prepare('SELECT count(*) n FROM forgetImportMessage WHERE batchId=?').get(batchId).n;
    if (!count) throw new Error('Aucun message valide trouvé dans cette source.');
    db.prepare("UPDATE forgetImport SET status='ready' WHERE id=?").run(batchId);
  } catch (e) {
    progress(); db.prepare("UPDATE forgetImport SET status='failed',error=? WHERE id=?").run(e.message, batchId);
  }
}

function batchStatus(db) {
  const b = db.prepare('SELECT * FROM forgetImport ORDER BY createdAt DESC,rowid DESC LIMIT 1').get();
  if (!b) return { status: 'idle' };
  const stats = db.prepare('SELECT count(*) messages,count(DISTINCT cid) channels,min(ts) firstTs,max(ts) lastTs FROM forgetImportMessage WHERE batchId=?').get(b.id);
  return { ...b, stats };
}
function planOut(db, id) {
  const p = db.prepare('SELECT * FROM forgetImportPlan WHERE id=?').get(id);
  return p ? { ...p, jobIds: JSON.parse(p.jobIds) } : null;
}

async function runPlan(db, plan, concurrency) {
  const state = { cancelled: false, jobIds: [] }; active.set(plan.id, state);
  const channels = db.prepare('SELECT DISTINCT cid FROM forgetImportPlanItem WHERE planId=? ORDER BY cid').all(plan.id);
  let next = 0, failed = false;
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, channels.length) }, async () => {
      while (!state.cancelled && !failed) {
        const ch = channels[next++]; if (!ch) return;
        let after = '';
        while (!state.cancelled && !failed) {
          const items = db.prepare('SELECT mid FROM forgetImportPlanItem WHERE planId=? AND cid=? AND mid>? ORDER BY mid LIMIT 100').all(plan.id, ch.cid, after);
          if (!items.length) break;
          const jobId = startDeleteJob({ channelId: ch.cid, messageIds: items.map(m => m.mid), speed: { mode: 'adaptive' }, planId: plan.id, allowBulk: false, verifyPages: true });
          state.jobIds.push(jobId);
          db.prepare('UPDATE forgetImportPlan SET jobIds=? WHERE id=?').run(JSON.stringify(state.jobIds), plan.id);
          await waitForJob(jobId);
          const job = store.getJob(jobId);
          if (job.status === 'cancelled') state.cancelled = true;
          if (job.status === 'failed' || job.failed) failed = true;
          after = items.at(-1).mid;
        }
      }
    }));
    db.prepare('UPDATE forgetImportPlan SET status=? WHERE id=?').run(state.cancelled ? 'cancelled' : failed ? 'failed' : 'done', plan.id);
  } catch (e) {
    db.prepare("UPDATE forgetImportPlan SET status='failed',error=? WHERE id=?").run(e.message, plan.id);
  } finally { active.delete(plan.id); }
}

export function importRouter(db) {
  const app = new Hono();
  app.onError((e, c) => c.json({ error: e.message }, 400));
  app.get('/status', c => c.json(batchStatus(db)));
  app.get('/latest', c => {
    const p = db.prepare('SELECT id FROM forgetImportPlan ORDER BY createdAt DESC,rowid DESC LIMIT 1').get();
    return c.json({ batch: batchStatus(db), plan: p ? planOut(db, p.id) : null });
  });
  app.post('/source', async c => {
    const { path } = await c.req.json();
    if (typeof path !== 'string' || !path.trim()) return c.json({ error: 'Chemin requis' }, 400);
    if (batchStatus(db).status === 'importing') return c.json({ error: 'Un import est déjà en cours' }, 409);
    const id = randomUUID();
    db.prepare("INSERT INTO forgetImport(id,source,status,createdAt) VALUES (?,?,'importing',?)").run(id, path, Date.now());
    void importSource(db, id, path);
    return c.json({ importId: id });
  });
  app.get('/channels', c => {
    const id = c.req.query('importId') || batchStatus(db).id;
    return c.json(db.prepare(`SELECT c.cid,c.name,c.kind,count(m.mid) count FROM forgetImportChannel c JOIN forgetImportMessage m ON m.batchId=c.batchId AND m.cid=c.cid WHERE c.batchId=? GROUP BY c.cid ORDER BY count DESC,c.cid LIMIT 10000`).all(id || ''));
  });
  app.post('/plan', async c => {
    const b = await c.req.json(), batch = batchStatus(db);
    if (batch.status !== 'ready' || (b.importId && b.importId !== batch.id)) return c.json({ error: 'Import terminé requis' }, 409);
    if (!Array.isArray(b.channelIds) || !b.channelIds.length || b.channelIds.length > 10000 || b.channelIds.some(id => !cleanId(id))) return c.json({ error: 'Sélectionnez au moins une conversation valide' }, 400);
    const since = b.since ? timestamp(b.since) : 0, until = b.until ? timestamp(b.until) : 8640000000000000;
    if (since === null || until === null || since > until) return c.json({ error: 'Plage de dates invalide' }, 400);
    const id = randomUUID();
    db.exec('BEGIN');
    try {
      const insert = db.prepare('INSERT OR IGNORE INTO forgetImportPlanItem SELECT ?,mid,cid,ts,content FROM forgetImportMessage WHERE batchId=? AND cid=? AND ts>=? AND ts<=?');
      for (const cid of new Set(b.channelIds)) insert.run(id, batch.id, cid, since, until);
      const count = db.prepare('SELECT count(*) n FROM forgetImportPlanItem WHERE planId=?').get(id).n;
      if (!count) throw new Error('Aucun message pour cette sélection');
      db.prepare("INSERT INTO forgetImportPlan(id,batchId,status,count,createdAt) VALUES (?,?,'ready',?,?)").run(id, batch.id, count, Date.now());
      db.exec('COMMIT'); return c.json({ planId: id, count });
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  });
  app.get('/plan/:id', c => {
    const plan = planOut(db, c.req.param('id'));
    if (!plan) return c.json({ error: 'Plan introuvable' }, 404);
    const jobs = plan.jobIds.map(store.getJob).filter(Boolean);
    const stats = jobs.reduce((a, j) => ({ deleted: a.deleted + j.deleted, failed: a.failed + j.failed, skipped: a.skipped + (j.skipped || 0) }), { deleted: 0, failed: 0, skipped: 0 });
    return c.json({ plan, stats, jobs, items: db.prepare('SELECT * FROM forgetImportPlanItem WHERE planId=? ORDER BY ts LIMIT 50').all(plan.id) });
  });
  app.post('/plan/:id/execute', async c => {
    const b = await c.req.json(), plan = planOut(db, c.req.param('id'));
    if (!plan) return c.json({ error: 'Plan introuvable' }, 404);
    if (plan.status !== 'ready') return c.json({ error: 'Ce plan a déjà été lancé. Construisez un nouveau plan pour reprendre.' }, 409);
    if (b.confirm !== true) return c.json({ error: 'Confirmation requise' }, 400);
    if (!store.getToken()) return c.json({ error: 'Discord non connecté' }, 409);
    if (active.size) return c.json({ error: 'Un plan est déjà en cours' }, 409);
    const concurrency = Math.min(8, Math.max(1, Math.floor(Number(b.concurrency) || 4)));
    db.prepare("UPDATE forgetImportPlan SET status='running' WHERE id=?").run(plan.id);
    void runPlan(db, plan, concurrency);
    return c.json({ planId: plan.id });
  });
  app.post('/plan/:id/cancel', c => {
    const state = active.get(c.req.param('id'));
    if (state) { state.cancelled = true; for (const id of state.jobIds) cancelJob(id); }
    return c.json({ ok: true });
  });
  return app;
}
