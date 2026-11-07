// Tables SQLite du module Discord + requêtes. Le token ne sort jamais d'ici que vers http.mjs.
import { randomUUID } from 'node:crypto';
import { parseTime } from './util.mjs';

let db = null;
// Cache des requêtes préparées (une compilation par SQL et par base) : les jobs appellent ces fonctions par message.
let stmts = new Map();
const prep = (sql) => {
  let st = stmts.get(sql);
  if (!st) { st = db.prepare(sql); stmts.set(sql, st); }
  return st;
};
const n = (v) => (v === undefined ? null : v);
const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = (s, fallback = null) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

export function initStore(database) {
  if (db !== database) stmts = new Map();
  db = database;
  db.exec(`
CREATE TABLE IF NOT EXISTS discordToken(id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT, userId TEXT, username TEXT, savedAt INTEGER);
CREATE TABLE IF NOT EXISTS discordArchive(id TEXT PRIMARY KEY, kind TEXT, platform TEXT, guildName TEXT, channelId TEXT, channelName TEXT,
  messageId TEXT, authorId TEXT, content TEXT, attachments TEXT, messageCreatedAt INTEGER, archivedAt INTEGER, action TEXT, meta TEXT);
CREATE TABLE IF NOT EXISTS discordJob(id TEXT PRIMARY KEY, kind TEXT, status TEXT, params TEXT, progress INTEGER, total INTEGER,
  deleted INTEGER, edited INTEGER, failed INTEGER, createdAt INTEGER, startedAt INTEGER, finishedAt INTEGER, error TEXT, cancelRequested INTEGER);
CREATE TABLE IF NOT EXISTS discordJobLog(id TEXT PRIMARY KEY, jobId TEXT, at INTEGER, level TEXT, message TEXT, meta TEXT);
CREATE TABLE IF NOT EXISTS discordDisappearing(id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER, delaySec INTEGER, scope TEXT,
  guildIds TEXT, updatedAt INTEGER);
CREATE TABLE IF NOT EXISTS setting(key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_discordArchive_at ON discordArchive(archivedAt);
CREATE INDEX IF NOT EXISTS idx_discordJobLog_job ON discordJobLog(jobId);
`);
  ensurePurgeTable();
  // Migration : curseur de progression des jobs (méthode historique).
  if (!db.prepare('PRAGMA table_info(discordJob)').all().some((c) => c.name === 'cursor')) db.exec('ALTER TABLE discordJob ADD COLUMN cursor TEXT');
  if (!db.prepare('PRAGMA table_info(discordJob)').all().some((c) => c.name === 'skipped')) db.exec('ALTER TABLE discordJob ADD COLUMN skipped INTEGER DEFAULT 0');
  db.prepare("INSERT OR IGNORE INTO discordDisappearing(id,enabled,delaySec,scope,guildIds,updatedAt) VALUES (1,0,3600,'all','[]',?)").run(Date.now());
}

// ---- token (l'avatar va dans la table setting : le schéma imposé n'a pas de colonne avatar)
// Chiffrement : si globalThis.__FORGET_CIPHER ({ encrypt(s)->b64, decrypt(b64)->s }) existe, le token est stocké "enc:v1:<b64>".
const ENC_PREFIX = 'enc:v1:';
const cipher = () => {
  const c = globalThis.__FORGET_CIPHER;
  return c && typeof c.encrypt === 'function' && typeof c.decrypt === 'function' ? c : null;
};
export const cipherKind = () => (cipher() ? 'dpapi' : 'plain');
/** true si le token stocké est chiffré en base. */
export const isTokenEncrypted = () => !!(db && prep('SELECT token FROM discordToken WHERE id=1').get())?.token?.startsWith(ENC_PREFIX);

/** Renvoie { token (clair), userId, username } ou null. Un token en clair est ré-écrit chiffré dès qu'un cipher existe. */
export function getToken() {
  const row = db ? prep('SELECT token,userId,username FROM discordToken WHERE id=1').get() : null;
  if (!row?.token) return null;
  const c = cipher();
  if (row.token.startsWith(ENC_PREFIX)) {
    if (!c) return null; // chiffré mais aucun cipher disponible : illisible
    try { return { ...row, token: c.decrypt(row.token.slice(ENC_PREFIX.length)) }; } catch { return null; }
  }
  if (c) {
    try { prep('UPDATE discordToken SET token=? WHERE id=1').run(ENC_PREFIX + c.encrypt(row.token)); } catch { /* reste en clair */ }
  }
  return row;
}
export function getAvatar() {
  return (db && prep("SELECT value FROM setting WHERE key='discord.avatar'").get())?.value || null;
}
export function setToken({ token, userId, username, avatar }) {
  const c = cipher();
  const stored = c ? ENC_PREFIX + c.encrypt(token) : token;
  prep('INSERT OR REPLACE INTO discordToken(id,token,userId,username,savedAt) VALUES (1,?,?,?,?)').run(stored, userId, username, Date.now());
  prep("INSERT OR REPLACE INTO setting(key,value) VALUES ('discord.avatar',?)").run(avatar ?? '');
}
export function clearToken() {
  prep('DELETE FROM discordToken WHERE id=1').run();
  prep("DELETE FROM setting WHERE key='discord.avatar'").run();
}

// ---- archive locale
export function insertArchive(r) {
  const id = randomUUID();
  prep(`INSERT INTO discordArchive(id,kind,platform,guildName,channelId,channelName,messageId,authorId,content,attachments,
    messageCreatedAt,archivedAt,action,meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, r.kind ?? 'message', r.platform ?? 'discord', n(r.guildName), n(r.channelId), n(r.channelName), n(r.messageId), n(r.authorId),
    r.content ?? '', json(r.attachments ?? []), n(r.messageCreatedAt), Date.now(), r.action, json(r.meta));
  return id;
}

const archiveOut = (r) => ({ ...r, attachments: parse(r.attachments, []), meta: parse(r.meta, null) });

export function queryArchive({ q, platform, from, to, limit = 100 } = {}) {
  const where = [], args = [];
  if (q) {
    const like = `%${String(q).replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    where.push("(content LIKE ? ESCAPE '\\' OR channelName LIKE ? ESCAPE '\\' OR guildName LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  if (platform) { where.push('platform = ?'); args.push(platform); }
  const f = parseTime(from), t = parseTime(to);
  if (f !== undefined) { where.push('archivedAt >= ?'); args.push(f); }
  if (t !== undefined) { where.push('archivedAt <= ?'); args.push(t); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 100000);
  const sql = `SELECT * FROM discordArchive ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY archivedAt DESC, rowid DESC LIMIT ?`;
  return prep(sql).all(...args, lim).map(archiveOut);
}

// ---- jobs
const JOB_COLS = new Set(['status', 'progress', 'total', 'deleted', 'edited', 'failed', 'skipped', 'startedAt', 'finishedAt', 'error', 'cancelRequested', 'cursor']);

export function createJob(kind, params) {
  const id = randomUUID();
  prep(`INSERT INTO discordJob(id,kind,status,params,progress,total,deleted,edited,failed,createdAt,cancelRequested)
    VALUES (?,?,'queued',?,0,0,0,0,0,?,0)`).run(id, kind, json(params), Date.now());
  return id;
}
export function updateJob(id, patch) {
  const keys = Object.keys(patch).filter((k) => JOB_COLS.has(k));
  if (!keys.length) return;
  prep(`UPDATE discordJob SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`).run(...keys.map((k) => n(patch[k])), id);
}
const jobOut = (r) => r && ({ ...r, params: parse(r.params, {}), cancelRequested: !!r.cancelRequested });
export const getJob = (id) => jobOut(prep('SELECT * FROM discordJob WHERE id=?').get(id));
export const listJobs = () => prep('SELECT * FROM discordJob ORDER BY createdAt DESC, rowid DESC').all().map(jobOut);
export const isCancelRequested = (id) => !!prep('SELECT cancelRequested c FROM discordJob WHERE id=?').get(id)?.c;
export const requestCancel = (id) => prep('UPDATE discordJob SET cancelRequested=1 WHERE id=?').run(id);
export const listActiveJobs = () =>
  prep("SELECT * FROM discordJob WHERE status IN ('queued','running') ORDER BY createdAt, rowid").all().map(jobOut);
export const activeJobIds = () => prep("SELECT id FROM discordJob WHERE status IN ('queued','running')").all().map((r) => r.id);
export function markInterrupted() {
  prep("UPDATE discordJob SET status='interrupted', finishedAt=?, error='interrompu par arrêt du serveur' WHERE status IN ('queued','running')").run(Date.now());
}

export function addLog(jobId, level, message, meta) {
  prep('INSERT INTO discordJobLog(id,jobId,at,level,message,meta) VALUES (?,?,?,?,?,?)').run(randomUUID(), jobId, Date.now(), level, message, json(meta));
}
export const getLogs = (jobId) =>
  prep('SELECT * FROM discordJobLog WHERE jobId=? ORDER BY at, rowid').all(jobId).map((r) => ({ ...r, meta: parse(r.meta, null) }));

// ---- mode disparition (configuration persistée)
export function getDisappearing() {
  const r = prep('SELECT * FROM discordDisappearing WHERE id=1').get();
  return { enabled: !!r.enabled, delaySec: r.delaySec, scope: r.scope, guildIds: parse(r.guildIds, []), updatedAt: r.updatedAt };
}
export function setDisappearing(patch) {
  const next = { ...getDisappearing(), ...patch };
  prep('UPDATE discordDisappearing SET enabled=?,delaySec=?,scope=?,guildIds=?,updatedAt=? WHERE id=1')
    .run(next.enabled ? 1 : 0, next.delaySec, next.scope, JSON.stringify(next.guildIds), Date.now());
  return getDisappearing();
}

// ---- purges reprenables (curseur `before` persisté, traitement par lots)
const PURGE_COLS = new Set(['status', 'chunkSize', 'intervalSec', 'speed', 'fromTs', 'toTs', 'cursorBefore', 'processed', 'deleted',
  'failed', 'runs', 'lastRunAt', 'nextRunAt', 'error']);

export function ensurePurgeTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS discordPurge(id TEXT PRIMARY KEY, channelId TEXT, guildId TEXT, guildName TEXT, channelName TEXT,
  status TEXT, chunkSize INTEGER, intervalSec INTEGER, speed TEXT, fromTs INTEGER, toTs INTEGER, cursorBefore TEXT, processed INTEGER,
  deleted INTEGER, failed INTEGER, runs INTEGER, createdAt INTEGER, lastRunAt INTEGER, nextRunAt INTEGER, error TEXT);
CREATE INDEX IF NOT EXISTS idx_discordPurge_next ON discordPurge(status, nextRunAt);`);
}
const purgeOut = (r) => r && ({ ...r, speed: parse(r.speed, null) });
export function createPurge(p) {
  const id = randomUUID();
  const now = Date.now();
  prep(`INSERT INTO discordPurge(id,channelId,guildId,guildName,channelName,status,chunkSize,intervalSec,speed,fromTs,toTs,
    cursorBefore,processed,deleted,failed,runs,createdAt,lastRunAt,nextRunAt,error) VALUES (?,?,?,?,?,'active',?,?,?,?,?,NULL,0,0,0,0,?,NULL,?,NULL)`)
    .run(id, p.channelId, n(p.guildId), n(p.guildName), n(p.channelName), p.chunkSize, p.intervalSec, json(p.speed), n(p.fromTs), n(p.toTs), now, now);
  return id;
}
export function updatePurge(id, patch) {
  const keys = Object.keys(patch).filter((k) => PURGE_COLS.has(k));
  if (!keys.length) return;
  prep(`UPDATE discordPurge SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`)
    .run(...keys.map((k) => n(k === 'speed' ? json(patch[k]) : patch[k])), id);
}
export const getPurge = (id) => purgeOut(prep('SELECT * FROM discordPurge WHERE id=?').get(id));
export const listPurges = () => prep('SELECT * FROM discordPurge ORDER BY createdAt DESC, rowid DESC').all().map(purgeOut);
export const duePurges = (at = Date.now()) =>
  prep("SELECT id FROM discordPurge WHERE status='active' AND nextRunAt IS NOT NULL AND nextRunAt <= ? ORDER BY nextRunAt").all(at).map((r) => r.id);
