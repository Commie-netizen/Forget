// Moteurs asynchrones en mémoire (mode démo) : scan, removal, archive axe, scheduler.
// Aucun appel réseau : tout est simulé et déterministe quand c'est possible.
import { createHash } from 'node:crypto';
import * as repo from './repo.mjs';

export class EngineError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---- Timers suivis pour pouvoir tout arrêter proprement ----
const timers = new Set();
function later(ms, fn) {
  const t = setTimeout(() => {
    timers.delete(t);
    try { fn(); } catch (e) { console.error('[engine]', e); }
  }, ms);
  timers.add(t);
  return t;
}

// Durées (ms) : surchargeables pour les tests.
export const timing = { scanStart: 100, scanTotal: 1800, removalStep: 800, axeStart: 100, axeTotal: 1200 };

// ---- PRNG déterministe ----
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

const FIRST = ['Alex', 'Camille', 'Julien', 'Sarah', 'Thomas', 'Léa', 'Nicolas', 'Emma', 'Hugo', 'Chloé'];
const LAST = ['Martin', 'Bernard', 'Dubois', 'Moreau', 'Laurent', 'Simon', 'Michel', 'Garcia', 'Roux', 'Fontaine'];
const STREETS = ['rue de la Paix', 'avenue Victor Hugo', 'boulevard Voltaire', 'rue des Lilas', 'chemin du Moulin', 'place du Marché'];
const CITIES = ['Paris', 'Lyon', 'Marseille', 'Toulouse', 'Nantes', 'Lille', 'Bordeaux'];
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ---- Cron simplifié -> intervalle en ms (null si invalide) ----
// Formats : "@every 10s|5m|2h", "@hourly", "@daily", "@weekly", "*/N * * * *" (toutes les N minutes).
// Toute autre expression à 5 champs est traitée comme quotidienne (démo : pas de vrai calendrier cron).
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
  const count = 2 + Math.floor(rnd() * 4); // 2 à 5
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
  if (!profile) throw new EngineError(404, 'profil introuvable');
  const claw = repo.getClaw(clawId);
  if (!claw) throw new EngineError(404, 'claw introuvable');
  if (repo.findActiveScan(profileId, clawId)) throw new EngineError(409, 'un scan est déjà actif pour ce profil et ce broker');
  const job = repo.createScanJob(profileId, clawId, trigger);
  repo.addEvent('scan.queued', { scanJobId: job.id, profileId, clawId });

  later(timing.scanStart, () => repo.updateScanJob(job.id, { status: 'running', startedAt: Date.now() }));
  later(timing.scanTotal, () => {
    if (!repo.getProfile(profileId)) return; // profil supprimé entre-temps
    let n = 0;
    for (const data of generateResults(profile, claw, job.id)) {
      const res = repo.createScanResult(job.id, data);
      repo.createScreenshot(res.id, { kind: 'page', label: `${claw.name} - fiche trouvée`, data: PNG_1X1 });
      n++;
    }
    repo.updateScanJob(job.id, { status: 'succeeded', completedAt: Date.now() });
    repo.addEvent('scan.succeeded', { scanJobId: job.id, profileId, clawId, results: n });
  });
  return job;
}

// ---- Removal ----
const STEP_DEFS = [
  ['Soumission du formulaire d\'opt-out', 'submit'],
  ['Vérification de la demande', 'verify'],
  ['Attente de la confirmation du broker', 'poll'],
  ['Suppression confirmée', 'done'],
];

export function startRemoval(scanResultId, trigger = 'manual') {
  const result = repo.getScanResult(scanResultId);
  if (!result) throw new EngineError(404, 'résultat de scan introuvable');
  const scan = repo.getScanJob(result.scanJobId);
  if (!scan) throw new EngineError(404, 'scan associé introuvable');
  if (repo.findActiveRemoval(scanResultId)) throw new EngineError(409, 'une suppression est déjà en cours pour ce résultat');

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
      repo.updateRemovalStep(stepId, { status: 'ok', type, at: t, demo: true, detail: `étape ${type} simulée` });
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

// ---- Axes (réseaux sociaux) ----
const THING_TEXTS = {
  default: ['Merci pour le retour !', 'Je ne suis pas d\'accord avec ce point.', 'Voici le lien dont je parlais.', 'On se voit demain ?', 'Super idée, je participe.', 'Petite question sur la configuration.', 'Résolu, merci à tous.', 'À relire avant publication.'],
};
const CHANNELS = ['general', 'random', 'projets', 'support', 'perso'];
const SERVERS = ['Maison', 'Travail', 'Amis', 'Communauté'];

export function connectAxe(axeId, displayName) {
  if (!repo.getAxe(axeId)) throw new EngineError(404, 'axe introuvable');
  const acc = repo.createAxeAccount(axeId, displayName);
  repo.addEvent('axe.connected', { axeId, accountId: acc.id, displayName });
  return acc;
}

export function startArchive(axeId, accountId) {
  if (!repo.getAxe(axeId)) throw new EngineError(404, 'axe introuvable');
  const acc = repo.getAxeAccount(accountId);
  if (!acc || acc.axeId !== axeId) throw new EngineError(404, 'compte introuvable pour cet axe');
  if (repo.findActiveAxeJob(accountId)) throw new EngineError(409, 'une archive est déjà en cours pour ce compte');
  const job = repo.createAxeJob(axeId, accountId, 'archive');
  repo.addEvent('axe.queued', { axeJobId: job.id, axeId, accountId });

  later(timing.axeStart, () => repo.updateAxeJob(job.id, { status: 'running', startedAt: Date.now() }));
  later(timing.axeTotal, () => {
    const total = 5 + Math.floor(Math.random() * 16); // 5 à 20
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
  if (!repo.getAxeJob(jobId)) throw new EngineError(404, 'job axe introuvable');
  const n = repo.deleteMarkedThings(jobId);
  repo.addEvent('axe.deleted', { axeJobId: jobId, deleted: n });
  return n;
}

// ---- Schedules ----
export function createSchedule({ kind, targetId, cron }) {
  const every = cronIntervalMs(cron);
  if (!every) throw new EngineError(400, 'cron invalide (ex. "@every 30s", "*/5 * * * *", "@daily")');
  return repo.createSchedule({ kind, targetId, cron, nextRunAt: Date.now() + every });
}

// targetId (scan) : "profileId:clawId", ou un clawId (tous les profils), ou un profileId (tous les claws).
// targetId (axe) : un accountId, ou un axeId (premier compte connecté).
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

// Exécute les schedules échus ; exporté pour les tests.
export function tickScheduler(at = Date.now()) {
  for (const s of repo.dueSchedules(at)) {
    const every = cronIntervalMs(s.cron) ?? 86400000;
    repo.updateSchedule(s.id, at, at + every); // avant l'exécution : évite toute double exécution
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

// ---- Cycle de vie ----
export function stopAll() {
  stopScheduler();
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

// Annule tous les timers et vide les données utilisateur (catalogues et réglages conservés).
export function resetForTests() {
  stopAll();
  repo.wipeUserData();
}
