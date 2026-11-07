// HTTP /api routes (SPEC contract). Manual validation, JSON errors { error }.
import { Hono } from 'hono';
import * as repo from './repo.mjs';
import * as engine from './engine.mjs';
import { VERSION } from './db.mjs';
import { csvCell } from './csv.mjs';

const fail = (status, message) => new engine.EngineError(status, message);

// JSON body: {} if empty, 400 if invalid or not an object.
async function readBody(c) {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  let v;
  try { v = JSON.parse(raw); } catch { throw fail(400, 'invalid JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail(400, 'the body must be a JSON object');
  return v;
}

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

// Validate profile fields; partial allows primaryName to be absent.
function profileFields(b, partial) {
  if (!partial && !isStr(b.primaryName)) throw fail(400, 'primaryName is required');
  if (partial && b.primaryName !== undefined && !isStr(b.primaryName)) throw fail(400, 'invalid primaryName');
  for (const k of ['emails', 'phones']) {
    if (b[k] !== undefined && !isStrArray(b[k])) throw fail(400, `${k} must be an array of strings`);
  }
  for (const k of ['primaryAddress', 'dateOfBirth']) {
    if (b[k] != null && typeof b[k] !== 'string') throw fail(400, `${k} must be a string`);
  }
  const out = {};
  for (const k of ['primaryName', 'primaryAddress', 'dateOfBirth', 'emails', 'phones']) if (b[k] !== undefined) out[k] = b[k];
  return out;
}

const found = (v, what) => { if (!v) throw fail(404, `${what} not found`); return v; };

// ---- Export ----
const toCsv = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';

function exportData() {
  const profiles = repo.listProfiles();
  const claws = repo.listClaws();
  const jobs = repo.listScanJobs();
  const results = repo.listAllScanResults().map((r) => {
    const job = jobs.find((j) => j.id === r.scanJobId);
    return {
      ...r,
      profileId: job?.profileId ?? null,
      clawId: job?.clawId ?? null,
      clawName: claws.find((c) => c.id === job?.clawId)?.name ?? null,
      profileName: profiles.find((p) => p.id === job?.profileId)?.primaryName ?? null,
    };
  });
  return {
    exportedAt: new Date().toISOString(), version: VERSION, profiles, scanJobs: jobs, scanResults: results,
    removalJobs: repo.listRemovalJobs().map((j) => ({ ...j, steps: repo.listRemovalSteps(j.id) })),
    axeJobs: repo.listAxeJobs(), things: repo.listAllThings(), schedules: repo.listSchedules(), settings: repo.getSettings(),
  };
}

const RESULT_COLS = ['id', 'clawName', 'profileName', 'profileUrl', 'names', 'age', 'addresses', 'relatives', 'emails', 'phones', 'hash', 'createdAt'];

// Minimal custom ZIP: stored entries (method 0, no compression), UTF-8 names.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function buildZip(files) { // files: [{ name, data: string|Buffer }]
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = []; const central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---- Routes ----
export function buildRoutes() {
  const api = new Hono();
  // No CORS: the UI is served by this server (and by the Vite proxy in development). See security.mjs.

  api.onError((err, c) => {
    if (err instanceof engine.EngineError) return c.json({ error: err.message }, err.status);
    console.error('[api]', err);
    return c.json({ error: 'internal error' }, 500);
  });
  api.notFound((c) => c.json({ error: 'route not found' }, 404));

  api.get('/health', (c) => c.json({ ok: true, version: VERSION, mode: 'demo' }));

  // Profiles
  api.get('/profiles', (c) => c.json(repo.listProfiles()));
  api.post('/profiles', async (c) => c.json(repo.createProfile(profileFields(await readBody(c), false)), 201));
  api.get('/profiles/:id', (c) => c.json(found(repo.getProfile(c.req.param('id')), 'profil')));
  api.patch('/profiles/:id', async (c) => {
    found(repo.getProfile(c.req.param('id')), 'profil');
    return c.json(repo.updateProfile(c.req.param('id'), profileFields(await readBody(c), true)));
  });
  api.delete('/profiles/:id', (c) => {
    found(repo.deleteProfile(c.req.param('id')), 'profil');
    return c.json({ ok: true });
  });

  // Catalogs, scan
  api.get('/claws', (c) => c.json(repo.listClaws()));
  // Bulk scan: one scanJob per enabled broker, with no count limit.
  api.post('/claws/scan-all', async (c) => {
    const b = await readBody(c);
    if (!isStr(b.profileId) || !repo.getProfile(b.profileId)) throw fail(400, 'profileId absent ou profil inconnu');
    const jobIds = [];
    for (const claw of repo.listClaws()) {
      if (claw.enabled === false) continue;
      try { jobIds.push(engine.startScan(b.profileId, claw.id).id); } catch (e) {
        if (!(e instanceof engine.EngineError) || e.status !== 409) throw e; // scan already active: skip
      }
    }
    return c.json({ jobIds, total: jobIds.length }, 201);
  });
  api.post('/claws/:id/scan', async (c) => {
    const b = await readBody(c);
    if (!isStr(b.profileId)) throw fail(400, 'profileId is required');
    return c.json(engine.startScan(b.profileId, c.req.param('id')), 201);
  });
  api.get('/scan-jobs', (c) => c.json(repo.listScanJobs()));
  api.get('/scan-jobs/:id', (c) => {
    const job = found(repo.getScanJob(c.req.param('id')), 'scan');
    return c.json({ ...job, results: repo.listScanResults(job.id) });
  });
  api.get('/scan-results/:id', (c) => {
    const r = found(repo.getScanResult(c.req.param('id')), 'result');
    return c.json({ ...r, screenshots: repo.listScreenshots(r.id) });
  });
  api.post('/scan-results/:id/removal', (c) => c.json(engine.startRemoval(c.req.param('id')), 201));
  api.get('/removal-jobs', (c) => c.json(repo.listRemovalJobs()));
  api.get('/removal-jobs/:id', (c) => {
    const job = found(repo.getRemovalJob(c.req.param('id')), 'removal');
    return c.json({ ...job, steps: repo.listRemovalSteps(job.id) });
  });

  // Axes
  api.get('/axes', (c) => c.json(repo.listAxes()));
  api.post('/axes/:id/connect', async (c) => {
    const b = await readBody(c);
    if (!isStr(b.displayName)) throw fail(400, 'displayName is required');
    return c.json(engine.connectAxe(c.req.param('id'), b.displayName.trim()), 201);
  });
  api.get('/axes/:id/accounts', (c) => {
    found(repo.getAxe(c.req.param('id')), 'axe');
    return c.json(repo.listAxeAccounts(c.req.param('id')));
  });
  api.post('/axes/:id/archive', async (c) => {
    const b = await readBody(c);
    if (!isStr(b.accountId)) throw fail(400, 'accountId is required');
    return c.json(engine.startArchive(c.req.param('id'), b.accountId), 201);
  });
  api.get('/axe-jobs', (c) => c.json(repo.listAxeJobs()));
  api.get('/axe-jobs/:id', (c) => {
    const job = found(repo.getAxeJob(c.req.param('id')), 'job axe');
    return c.json({ ...job, things: repo.listThings(job.id) });
  });
  // Optional body { marked:false } to unmark.
  api.post('/things/:id/mark', async (c) => {
    found(repo.getThing(c.req.param('id')), 'item');
    const b = await readBody(c);
    return c.json(repo.markThing(c.req.param('id'), b.marked !== false));
  });
  api.post('/axe-jobs/:id/delete-marked', (c) => c.json({ deleted: engine.deleteMarked(c.req.param('id')) }));

  // Schedules
  api.get('/schedules', (c) => c.json(repo.listSchedules()));
  api.post('/schedules', async (c) => {
    const b = await readBody(c);
    if (b.kind !== 'scan' && b.kind !== 'axe') throw fail(400, 'kind doit valoir "scan" ou "axe"');
    if (!isStr(b.targetId)) throw fail(400, 'targetId is required');
    if (!isStr(b.cron)) throw fail(400, 'cron is required');
    return c.json(engine.createSchedule({ kind: b.kind, targetId: b.targetId.trim(), cron: b.cron.trim() }), 201);
  });
  api.delete('/schedules/:id', (c) => {
    found(repo.deleteSchedule(c.req.param('id')), 'schedule');
    return c.json({ ok: true });
  });

  // Export
  api.get('/export', (c) => {
    const format = c.req.query('format') ?? 'json';
    const stamp = new Date().toISOString().slice(0, 10);
    const attach = (ext) => ({ 'Content-Disposition': `attachment; filename="forget-export-${stamp}.${ext}"` });
    const data = exportData();
    if (format === 'json') {
      return new Response(JSON.stringify(data, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8', ...attach('json') } });
    }
    if (format === 'csv') {
      return new Response(toCsv(data.scanResults, RESULT_COLS), { headers: { 'Content-Type': 'text/csv; charset=utf-8', ...attach('csv') } });
    }
    if (format === 'zip') {
      const zip = buildZip([
        { name: 'export.json', data: JSON.stringify(data, null, 2) },
        { name: 'scan-results.csv', data: toCsv(data.scanResults, RESULT_COLS) },
        { name: 'profiles.json', data: JSON.stringify(data.profiles, null, 2) },
        { name: 'removal-jobs.json', data: JSON.stringify(data.removalJobs, null, 2) },
        { name: 'things.json', data: JSON.stringify(data.things, null, 2) },
      ]);
      return new Response(zip, { headers: { 'Content-Type': 'application/zip', ...attach('zip') } });
    }
    throw fail(400, 'format doit valoir csv, json ou zip');
  });

  api.get('/events', (c) => {
    const n = Number(c.req.query('limit') ?? 50);
    if (!Number.isInteger(n) || n < 1) throw fail(400, 'invalid limit');
    return c.json(repo.listEvents(Math.min(n, 500)));
  });

  // Settings
  api.get('/settings', (c) => c.json(repo.getSettings()));
  api.patch('/settings', async (c) => {
    const b = await readBody(c);
    if (b.theme !== undefined && b.theme !== 'dark' && b.theme !== 'light') throw fail(400, 'theme doit valoir "dark" ou "light"');
    if (b.mode !== undefined && b.mode !== 'demo') throw fail(400, 'only "demo" mode is supported');
    // Reserved keys (privacy, accounts, updates) have their own validated routes.
    if (Object.keys(b).some((k) => /^(privacy|discord|update|social|tiktok)\./.test(k))) throw fail(400, 'reserved setting key');
    return c.json(repo.patchSettings(b));
  });

  return api;
}
