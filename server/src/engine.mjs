// Asynchronous in-memory engines (demo mode): scan, removal, axe archive, scheduler.
// No network calls: everything is simulated and deterministic where possible.
import { createHash } from 'node:crypto';
import * as repo from './repo.mjs';

export class EngineError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---- Track timers for clean shutdown ----
const timers = new Set();
function later(ms, fn) {
  const t = setTimeout(() => {
    timers.delete(t);
    try { fn(); } catch (e) { console.error('[engine]', e); }
  }, ms);
  timers.add(t);
  return t;
}

// Durations (ms): can be overridden in tests.
export const timing = { scanStart: 100, scanTotal: 1800, removalStep: 800, axeStart: 100, axeTotal: 1200 };

// ---- Deterministic PRNG ----
const seedFrom = (s) => createHash('sha256').update(s).digest().readUInt32BE(0);
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const FIRST = ['Alex', 'Jordan', 'Taylor', 'Sarah', 'Thomas', 'Morgan', 'Nicolas', 'Emma', 'Hugo', 'Chloe'];
const LAST = ['Martin', 'Bennett', 'Carter', 'Morgan', 'Lawson', 'Simon', 'Mitchell', 'Garcia', 'Reed', 'Fontaine'];
const STREETS = ['Peace Street', 'Maple Avenue', 'Oak Boulevard', 'Lilac Lane', 'Mill Road', 'Market Square'];
const CITIES = ['Springfield', 'Riverside', 'Fairview', 'Madison', 'Georgetown', 'Clinton', 'Salem'];
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ---- Simplified cron -> interval in ms (null if invalid) ----
// Formats: "@every 10s|5m|2h", "@hourly", "@daily", "@weekly", "*/N * * * *" (every N minutes).
// Any other five-field expression is treated as daily (demo: no real cron calendar).
export function cronIntervalMs(cron) {
  const c = String(cron ?? '').trim();
  let m;
  if ((m = /^@every\s+(\d+)\s*([smh])$/i.exec(c))) {
    const n = Number(m[1]);
    return n > 0 ? n * { s: 1000, m: 60000, h: 3600000 }[m[2].toLowerCase()] : null;
  }
  if (c === '@hourly') return 3600000;
  if (c === '@daily') return 86400000;
  if (c === '@weekly') return 7 * 86400000;
  if ((m = /^\*\/(\d+)(\s+\S+){4}$/.exec(c))) return Number(m[1]) > 0 ? Number(m[1]) * 60000 : null;
  if (c.split(/\s+/).length === 5) return 86400000;
  return null;
}

// ---- Scan ----
function generateResults(profile, claw, jobId) {
  const rnd = mulberry32(seedFrom(profile.id + claw.id));
  const count = 2 + Math.floor(rnd() * 4); // 2 to 5
  const baseYear = profile.dateOfBirth ? new Date(profile.dateOfBirth).getFullYear() : NaN;
  const out = [];
  for (let i = 0; i < count; i++) {
    const hex = Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0');
    const age = Number.isFinite(baseYear) ? new Date().getFullYear() - baseYear + (i % 2) : 22 + Math.floor(rnd() * 50);
    const names = [profile.primaryName];
    if (rnd() > 0.4) names.push(`${pick(rnd, FIRST)} ${profile.primaryName.split(' ').slice(-1)[0]}`);
    const addr = () => `${1 + Math.floor(rnd() * 120)} ${pick(rnd, STREETS)}, ${pick(rnd, CITIES)}`;
    const addresses = [profile.primaryAddress || addr(), ...(rnd() > 0.5 ? [addr()] : [])];
    const relatives = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => `${pick(rnd, FIRST)} ${pick(rnd, LAST)}`);
    const emails = profile.emails.length ? profile.emails.slice(0, 1 + Math.floor(rnd() * 2)) : [`${slug(profile.primaryName)}${Math.floor(rnd() * 99)}@example.com`];
    const phones = profile.phones.length ? profile.phones.slice(0, 1) : [`+33 6 ${Math.floor(10 + rnd() * 89)} ${Math.floor(10 + rnd() * 89)} ${Math.floor(10 + rnd() * 89)} ${Math.floor(10 + rnd() * 89)}`];
    const data = {
      profileUrl: `https://www.${claw.website}/people/${slug(profile.primaryName)}/${hex}`,
      names, age, addresses, relatives, emails, phones,
      extras: { category: claw.category, confidence: Math.round((0.6 + rnd() * 0.4) * 100) / 100, demo: true },
    };
    data.hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    out.push(data);
  }
  return out;
}

export function startScan(profileId, clawId, trigger = 'manual') {
  const profile = repo.getProfile(profileId);
  if (!profile) throw new EngineError(404, 'profile not found');
  const claw = repo.getClaw(clawId);
  if (!claw) throw new EngineError(404, 'claw not found');
  if (repo.findActiveScan(profileId, clawId)) throw new EngineError(409, 'a scan is already active for this profile and broker');
  const job = repo.createScanJob(profileId, clawId, trigger);
  repo.addEvent('scan.queued', { scanJobId: job.id, profileId, clawId });

  later(timing.scanStart, () => repo.updateScanJob(job.id, { status: 'running', startedAt: Date.now() }));
  later(timing.scanTotal, () => {
    if (!repo.getProfile(profileId)) return; // profile deleted in the meantime
    let n = 0;
    for (const data of generateResults(profile, claw, job.id)) {
      const res = repo.createScanResult(job.id, data);
      repo.createScreenshot(res.id, { kind: 'page', label: `${claw.name} - listing found`, data: PNG_1X1 });
      n++;
    }
    repo.updateScanJob(job.id, { status: 'succeeded', completedAt: Date.now() });
    repo.addEvent('scan.succeeded', { scanJobId: job.id, profileId, clawId, results: n });
  });
  return job;
}

// ---- Removal ----
const STEP_DEFS = [
  ['Opt-out form submitted', 'submit'],
  ['Request verified', 'verify'],
  ['Waiting for broker confirmation', 'poll'],
  ['Removal confirmed', 'done'],
];

export function startRemoval(scanResultId, trigger = 'manual') {
  const result = repo.getScanResult(scanResultId);
  if (!result) throw new EngineError(404, 'scan result not found');
  const scan = repo.getScanJob(result.scanJobId);
  if (!scan) throw new EngineError(404, 'related scan not found');
  if (repo.findActiveRemoval(scanResultId)) throw new EngineError(409, 'a removal is already in progress for this result');

  const job = repo.createRemovalJob({ clawId: scan.clawId, profileId: scan.profileId, scanResultId, trigger });
  const stepIds = STEP_DEFS.map(([name, type]) => repo.createRemovalStep(job.id, name, type));
  repo.addEvent('removal.queued', { removalJobId: job.id, scanResultId, clawId: scan.clawId });

  const dt = timing.removalStep;
  later(Math.min(100, dt), () => {
    const t = Date.now();
    repo.updateRemovalJob(job.id, { status: 'running', startedAt: t, nextPollAt: t + dt, pollTimeoutAt: t + dt * 10 });
  });
  stepIds.forEach((stepId, i) => {
    later(dt * (i + 1), () => {
      const t = Date.now();
      const [, type] = STEP_DEFS[i];
      repo.updateRemovalStep(stepId, { status: 'ok', type, at: t, demo: true, detail: `simulated ${type} step` });
      if (i < STEP_DEFS.length - 1) {
        repo.updateRemovalJob(job.id, { nextPollAt: t + dt });
      } else {
        repo.updateRemovalJob(job.id, { status: 'succeeded', finishedAt: t, nextPollAt: null });
        repo.addEvent('removal.succeeded', { removalJobId: job.id, scanResultId });
      }
    });
  });
  return job;
}

// ---- Axes (social networks) ----
const THING_TEXTS = {
  default: ['Thanks for the feedback!', 'I disagree with that point.', 'Here is the link I mentioned.', 'See you tomorrow?', 'Great idea, count me in.', 'Quick question about the setup.', 'Solved, thanks everyone.', 'Proofread before publishing.'],
};
const CHANNELS = ['general', 'random', 'projects', 'support', 'personal'];
const SERVERS = ['Home', 'Work', 'Friends', 'Community'];

export function connectAxe(axeId, displayName) {
  if (!repo.getAxe(axeId)) throw new EngineError(404, 'axe not found');
  const acc = repo.createAxeAccount(axeId, displayName);
  repo.addEvent('axe.connected', { axeId, accountId: acc.id, displayName });
  return acc;
}

export function startArchive(axeId, accountId) {
  if (!repo.getAxe(axeId)) throw new EngineError(404, 'axe not found');
  const acc = repo.getAxeAccount(accountId);
  if (!acc || acc.axeId !== axeId) throw new EngineError(404, 'account not found for this axe');
  if (repo.findActiveAxeJob(accountId)) throw new EngineError(409, 'an archive is already in progress for this account');
  const job = repo.createAxeJob(axeId, accountId, 'archive');
  repo.addEvent('axe.queued', { axeJobId: job.id, axeId, accountId });

  later(timing.axeStart, () => repo.updateAxeJob(job.id, { status: 'running', startedAt: Date.now() }));
  later(timing.axeTotal, () => {
    const total = 5 + Math.floor(Math.random() * 16); // 5 to 20
    const t = Date.now();
    for (let i = 0; i < total; i++) {
      repo.createThing({
        jobId: job.id, axeId, accountId,
        serverName: SERVERS[i % SERVERS.length], channelName: CHANNELS[i % CHANNELS.length],
        text: THING_TEXTS.default[i % THING_TEXTS.default.length],
        thingDate: t - (i + 1) * 86400000 * 3,
      });
    }
    repo.updateAxeJob(job.id, { status: 'succeeded', completedAt: Date.now(), totalItems: total });
    repo.addEvent('axe.succeeded', { axeJobId: job.id, total });
  });
  return job;
}

export function deleteMarked(jobId) {
  if (!repo.getAxeJob(jobId)) throw new EngineError(404, 'axe job not found');
  const n = repo.deleteMarkedThings(jobId);
  repo.addEvent('axe.deleted', { axeJobId: jobId, deleted: n });
  return n;
}

// ---- Schedules ----
export function createSchedule({ kind, targetId, cron }) {
  const every = cronIntervalMs(cron);
  if (!every) throw new EngineError(400, 'invalid cron (e.g. "@every 30s", "*/5 * * * *", "@daily")');
  return repo.createSchedule({ kind, targetId, cron, nextRunAt: Date.now() + every });
}

// targetId (scan): "profileId:clawId", a clawId (all profiles), or a profileId (all claws).
// targetId (axe): an accountId or an axeId (first connected account).
function runSchedule(s) {
  let started = 0;
  const attempt = (fn) => { try { fn(); started++; } catch (e) { if (!(e instanceof EngineError)) throw e; } };
  if (s.kind === 'scan') {
    const [a, b] = s.targetId.split(':');
    const pairs = [];
    if (b) pairs.push([a, b]);
    else if (repo.getClaw(a)) repo.listProfiles().forEach((p) => pairs.push([p.id, a]));
    else if (repo.getProfile(a)) repo.listClaws().forEach((c) => pairs.push([a, c.id]));
    pairs.forEach(([p, c]) => attempt(() => startScan(p, c, 'schedule')));
  } else if (s.kind === 'axe') {
    const acc = repo.getAxeAccount(s.targetId);
    if (acc) attempt(() => startArchive(acc.axeId, acc.id));
    else if (repo.getAxe(s.targetId)) {
      const first = repo.listAxeAccounts(s.targetId)[0];
      if (first) attempt(() => startArchive(first.axeId, first.id));
    }
  }
  repo.addEvent('schedule.run', { scheduleId: s.id, kind: s.kind, started });
}

// Run due schedules; exported for tests.
export function tickScheduler(at = Date.now()) {
  for (const s of repo.dueSchedules(at)) {
    const every = cronIntervalMs(s.cron) ?? 86400000;
    repo.updateSchedule(s.id, at, at + every); // before execution: prevent duplicate execution
    runSchedule(s);
  }
}

let schedulerTimer = null;
export function startScheduler(ms = 2000) {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    try { tickScheduler(); } catch (e) { console.error('[scheduler]', e); }
  }, ms);
  schedulerTimer.unref?.();
}
export function stopScheduler() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
}

// ---- Lifecycle ----
export function stopAll() {
  stopScheduler();
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

// Cancel all timers and clear user data (retain catalogs and settings).
export function resetForTests() {
  stopAll();
  repo.wipeUserData();
}
