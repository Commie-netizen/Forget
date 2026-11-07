// Data access: simple SQL queries, JSON serialized as TEXT, row -> object.
import { randomUUID } from 'node:crypto';
import { getDb } from './db.mjs';

const now = () => Date.now();
export const newId = () => randomUUID();

const q = (sql, ...p) => getDb().prepare(sql).all(...p).map((r) => ({ ...r }));
const one = (sql, ...p) => { const r = getDb().prepare(sql).get(...p); return r ? { ...r } : null; };
const run = (sql, ...p) => getDb().prepare(sql).run(...p);

const parse = (s, fallback) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };
const bool = (v) => v === 1 || v === true;

// Generic UPDATE from a field object (column names supplied by code, never by the user).
function update(table, id, fields, extra = '') {
  const keys = Object.keys(fields);
  run(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')}${extra} WHERE id=?`, ...keys.map((k) => fields[k]), ...(extra ? [now()] : []), id);
}

// ---- Profiles ----
const profileOut = (r) => r && ({ ...r, emails: parse(r.emails, []), phones: parse(r.phones, []) });

export const listProfiles = () => q('SELECT * FROM profile ORDER BY createdAt').map(profileOut);
export const getProfile = (id) => profileOut(one('SELECT * FROM profile WHERE id=?', id));

export function createProfile(d) {
  const id = newId(); const t = now();
  run('INSERT INTO profile VALUES (?,?,?,?,?,?,?,?)', id, d.primaryName, d.primaryAddress ?? null, d.dateOfBirth ?? null,
    JSON.stringify(d.emails ?? []), JSON.stringify(d.phones ?? []), t, t);
  return getProfile(id);
}

export function updateProfile(id, d) {
  const cur = getProfile(id);
  if (!cur) return null;
  const m = { ...cur, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) };
  run('UPDATE profile SET primaryName=?, primaryAddress=?, dateOfBirth=?, emails=?, phones=?, updatedAt=? WHERE id=?',
    m.primaryName, m.primaryAddress ?? null, m.dateOfBirth ?? null, JSON.stringify(m.emails ?? []), JSON.stringify(m.phones ?? []), now(), id);
  return getProfile(id);
}

// Cascade deletion of the profile's scans, results, screenshots, and removals.
export function deleteProfile(id) {
  if (!getProfile(id)) return false;
  const jobs = '(SELECT id FROM scanJob WHERE profileId=?)';
  const results = `(SELECT id FROM scanResult WHERE scanJobId IN ${jobs})`;
  run(`DELETE FROM screenshot WHERE scanResultId IN ${results}`, id);
  run(`DELETE FROM scanResult WHERE scanJobId IN ${jobs}`, id);
  run('DELETE FROM removalStep WHERE removalJobId IN (SELECT id FROM removalJob WHERE profileId=?)', id);
  run('DELETE FROM removalJob WHERE profileId=?', id);
  run('DELETE FROM scanJob WHERE profileId=?', id);
  run('DELETE FROM profile WHERE id=?', id);
  return true;
}

// ---- Catalogs ----
const catOut = (r) => r && ({ ...r, demo: bool(r.demo), ...(r.enabled === undefined ? {} : { enabled: bool(r.enabled) }) });
export const listClaws = () => q('SELECT * FROM claw ORDER BY name').map(catOut);
export const getClaw = (id) => catOut(one('SELECT * FROM claw WHERE id=?', id));
export const listAxes = () => q('SELECT * FROM axe ORDER BY name').map(catOut);
export const getAxe = (id) => catOut(one('SELECT * FROM axe WHERE id=?', id));

// ---- Scan ----
export const listScanJobs = () => q('SELECT * FROM scanJob ORDER BY createdAt DESC');
export const getScanJob = (id) => one('SELECT * FROM scanJob WHERE id=?', id);
export const findActiveScan = (profileId, clawId) =>
  one("SELECT * FROM scanJob WHERE profileId=? AND clawId=? AND status IN ('queued','running')", profileId, clawId);

export function createScanJob(profileId, clawId, trigger = 'manual') {
  const id = newId();
  run("INSERT INTO scanJob VALUES (?,?,?,'queued',?,?,NULL,NULL,NULL)", id, profileId, clawId, trigger, now());
  return getScanJob(id);
}
export function updateScanJob(id, f) { update('scanJob', id, f); return getScanJob(id); }

const resultOut = (r) => r && ({
  ...r, names: parse(r.names, []), addresses: parse(r.addresses, []), relatives: parse(r.relatives, []),
  emails: parse(r.emails, []), phones: parse(r.phones, []), extras: parse(r.extras, {}),
});

export function createScanResult(scanJobId, d) {
  const id = newId();
  run('INSERT INTO scanResult VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', id, scanJobId, d.profileUrl, JSON.stringify(d.names),
    d.age ?? null, JSON.stringify(d.addresses), JSON.stringify(d.relatives), JSON.stringify(d.emails),
    JSON.stringify(d.phones), JSON.stringify(d.extras ?? {}), d.hash, now());
  return getScanResult(id);
}
export const getScanResult = (id) => resultOut(one('SELECT * FROM scanResult WHERE id=?', id));
export const listScanResults = (scanJobId) => q('SELECT * FROM scanResult WHERE scanJobId=? ORDER BY createdAt, rowid', scanJobId).map(resultOut);
export const listAllScanResults = () => q('SELECT * FROM scanResult ORDER BY createdAt, rowid').map(resultOut);

export function createScreenshot(scanResultId, d) {
  const id = newId();
  run('INSERT INTO screenshot VALUES (?,?,?,?,?,?)', id, scanResultId, d.kind, d.label, d.data, now());
  return id;
}
export const listScreenshots = (scanResultId) => q('SELECT * FROM screenshot WHERE scanResultId=? ORDER BY createdAt, rowid', scanResultId);

// ---- Removal ----
export const listRemovalJobs = () => q('SELECT * FROM removalJob ORDER BY createdAt DESC');
export const getRemovalJob = (id) => one('SELECT * FROM removalJob WHERE id=?', id);
export const findActiveRemoval = (scanResultId) =>
  one("SELECT * FROM removalJob WHERE scanResultId=? AND status IN ('queued','running')", scanResultId);

export function createRemovalJob({ clawId, profileId, scanResultId, trigger = 'manual' }) {
  const id = newId(); const t = now();
  run("INSERT INTO removalJob VALUES (?,?,?,?,'queued',?,NULL,NULL,NULL,NULL,NULL,?,?)", id, clawId, profileId, scanResultId, trigger, t, t);
  return getRemovalJob(id);
}
export function updateRemovalJob(id, f) { update('removalJob', id, f, ', updatedAt=?'); return getRemovalJob(id); }

const stepOut = (r) => r && ({ ...r, result: parse(r.result, null) });
export function createRemovalStep(removalJobId, name, type) {
  const id = newId(); const t = now();
  run('INSERT INTO removalStep VALUES (?,?,?,?,?,?,?)', id, removalJobId, name, type, JSON.stringify({ status: 'pending' }), t, t);
  return id;
}
export function updateRemovalStep(id, result) {
  run('UPDATE removalStep SET result=?, updatedAt=? WHERE id=?', JSON.stringify(result), now(), id);
}
export const listRemovalSteps = (jobId) => q('SELECT * FROM removalStep WHERE removalJobId=? ORDER BY createdAt, rowid', jobId).map(stepOut);

// ---- Axes ----
export const listAxeAccounts = (axeId) => q('SELECT * FROM axeAccount WHERE axeId=? ORDER BY connectedAt, rowid', axeId);
export const getAxeAccount = (id) => one('SELECT * FROM axeAccount WHERE id=?', id);
export function createAxeAccount(axeId, displayName) {
  const id = newId();
  run("INSERT INTO axeAccount VALUES (?,?,?,'connected',?)", id, axeId, displayName, now());
  return getAxeAccount(id);
}

export const listAxeJobs = () => q('SELECT * FROM axeJob ORDER BY createdAt DESC');
export const getAxeJob = (id) => one('SELECT * FROM axeJob WHERE id=?', id);
export const findActiveAxeJob = (accountId) =>
  one("SELECT * FROM axeJob WHERE accountId=? AND status IN ('queued','running')", accountId);
export function createAxeJob(axeId, accountId, mode = 'archive') {
  const id = newId();
  run("INSERT INTO axeJob VALUES (?,?,?,'queued',?,?,NULL,NULL,0,0)", id, axeId, accountId, mode, now());
  return getAxeJob(id);
}
export function updateAxeJob(id, f) { update('axeJob', id, f); return getAxeJob(id); }

const thingOut = (r) => r && ({ ...r, isDeleted: bool(r.isDeleted), markedForDeletion: bool(r.markedForDeletion) });
export function createThing(t) {
  const id = newId();
  run('INSERT INTO thing VALUES (?,?,?,?,?,?,?,?,?,0,0)', id, t.jobId, t.axeId, t.accountId, t.serverName, t.channelName, t.text, t.thingDate, now());
  return id;
}
export const getThing = (id) => thingOut(one('SELECT * FROM thing WHERE id=?', id));
export const listThings = (jobId) => q('SELECT * FROM thing WHERE jobId=? ORDER BY thingDate DESC, rowid', jobId).map(thingOut);
export const listAllThings = () => q('SELECT * FROM thing ORDER BY thingDate DESC, rowid').map(thingOut);
export function markThing(id, marked = true) {
  run('UPDATE thing SET markedForDeletion=? WHERE id=? AND isDeleted=0', marked ? 1 : 0, id);
  return getThing(id);
}
// Delete (isDeleted=1) marked things in a job and return their count.
export function deleteMarkedThings(jobId) {
  const n = Number(run('UPDATE thing SET isDeleted=1 WHERE jobId=? AND markedForDeletion=1 AND isDeleted=0', jobId).changes);
  run('UPDATE axeJob SET totalDeleted=totalDeleted+? WHERE id=?', n, jobId);
  return n;
}

// ---- Schedules ----
const schedOut = (r) => r && ({ ...r, enabled: bool(r.enabled) });
export const listSchedules = () => q('SELECT * FROM schedule ORDER BY rowid').map(schedOut);
export const getSchedule = (id) => schedOut(one('SELECT * FROM schedule WHERE id=?', id));
export const dueSchedules = (t) => q('SELECT * FROM schedule WHERE enabled=1 AND nextRunAt<=?', t).map(schedOut);
export function createSchedule({ kind, targetId, cron, nextRunAt }) {
  const id = newId();
  run('INSERT INTO schedule VALUES (?,?,?,?,1,NULL,?)', id, kind, targetId, cron, nextRunAt);
  return getSchedule(id);
}
export function updateSchedule(id, lastRunAt, nextRunAt) {
  run('UPDATE schedule SET lastRunAt=?, nextRunAt=? WHERE id=?', lastRunAt, nextRunAt, id);
}
export const deleteSchedule = (id) => Number(run('DELETE FROM schedule WHERE id=?', id).changes) > 0;

// ---- Events ----
const eventOut = (r) => ({ ...r, payload: parse(r.payload, null) });
export function addEvent(type, payload = {}) {
  run('INSERT INTO event VALUES (?,?,?,?)', newId(), now(), type, JSON.stringify(payload));
}
export const listEvents = (limit = 50) => q('SELECT * FROM event ORDER BY at DESC, rowid DESC LIMIT ?', limit).map(eventOut);

// ---- Settings ----
export function getSettings() {
  return Object.fromEntries(q('SELECT * FROM setting').map((r) => [r.key, parse(r.value, null)]));
}
export function patchSettings(patch) {
  const st = getDb().prepare('INSERT INTO setting VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(patch)) st.run(k, JSON.stringify(v));
  return getSettings();
}

// ---- Maintenance ----

// At startup: jobs left active by a previous process will never resume.
export function recoverInterrupted() {
  const t = now();
  run("UPDATE scanJob SET status='failed', failure='interrompu', completedAt=? WHERE status IN ('queued','running')", t);
  run("UPDATE removalJob SET status='failed', failure='interrompu', finishedAt=?, updatedAt=? WHERE status IN ('queued','running')", t, t);
  run("UPDATE axeJob SET status='failed', completedAt=? WHERE status IN ('queued','running')", t);
}

// Clear user data (retain catalogs and settings).
export function wipeUserData() {
  for (const t of ['profile', 'scanJob', 'scanResult', 'screenshot', 'removalJob', 'removalStep', 'axeAccount', 'axeJob', 'thing', 'schedule', 'event']) {
    run(`DELETE FROM ${t}`);
  }
}
