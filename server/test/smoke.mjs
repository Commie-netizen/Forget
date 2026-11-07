// Test de fumée : parcours complet via app.request (sans réseau), sur une base temporaire.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'forget-smoke-'));
process.env.FORGET_DB_PATH = join(tmp, 'smoke.sqlite'); // avant tout import du serveur

const { createApp } = await import('../src/index.mjs');
const engine = await import('../src/engine.mjs');
const { closeDb } = await import('../src/db.mjs');

engine.resetForTests(); // idempotence : base propre à chaque lancement
const app = createApp();

let pass = 0, total = 0;
function check(name, cond, extra = '') {
  total++;
  if (cond) { pass++; console.log(`  ok   ${name}`); } else console.log(`  FAIL ${name} ${extra}`);
}
async function call(method, path, body) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'X-Forget-Request': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json() : null;
  return { res, status: res.status, data };
}
async function waitFor(path, pred, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { data } = await call('GET', path);
    if (pred(data)) return data;
    await new Promise((r) => setTimeout(r, 150));
  }
  return (await call('GET', path)).data;
}

try {
  // health
  let r = await call('GET', '/health');
  check('health', r.status === 200 && r.data.ok === true && r.data.mode === 'demo');

  // profil : validation puis création
  r = await call('POST', '/profiles', {});
  check('profil sans nom -> 400', r.status === 400 && !!r.data.error);
  r = await call('POST', '/profiles', { primaryName: 'Camille Martin', primaryAddress: '12 rue des Lilas, Lyon', dateOfBirth: '1990-04-12', emails: ['camille@example.com'], phones: ['+33 6 12 34 56 78'] });
  const profile = r.data;
  check('création profil', r.status === 201 && !!profile.id && profile.emails[0] === 'camille@example.com');
  r = await call('PATCH', `/profiles/${profile.id}`, { primaryName: 'Camille M. Martin' });
  check('patch profil', r.status === 200 && r.data.primaryName === 'Camille M. Martin');
  r = await call('GET', '/profiles/inconnu');
  check('profil inconnu -> 404', r.status === 404);

  // catalogue
  r = await call('GET', '/claws');
  const claws = r.data;
  check('claws >= 8', Array.isArray(claws) && claws.length >= 8 && claws.every((c) => c.demo === true));
  r = await call('GET', '/axes');
  const axes = r.data;
  check('axes >= 5 dont claude-ai', axes.length >= 5 && axes.some((a) => a.id === 'claude-ai'));

  // scan
  const claw = claws[0];
  r = await call('POST', `/claws/${claw.id}/scan`, {});
  check('scan sans profileId -> 400', r.status === 400);
  r = await call('POST', `/claws/${claw.id}/scan`, { profileId: profile.id });
  const scan = r.data;
  check('lancement scan', r.status === 201 && scan.status === 'queued');
  r = await call('POST', `/claws/${claw.id}/scan`, { profileId: profile.id });
  check('scan actif en double -> 409', r.status === 409);
  const scanDone = await waitFor(`/scan-jobs/${scan.id}`, (d) => d.status === 'succeeded' || d.status === 'failed');
  check('scan succeeded avec 2-5 résultats', scanDone.status === 'succeeded' && scanDone.results.length >= 2 && scanDone.results.length <= 5, JSON.stringify(scanDone.status));

  // résultat + screenshots
  const result = scanDone.results[0];
  r = await call('GET', `/scan-results/${result.id}`);
  check('résultat + screenshot data-URI', r.status === 200 && r.data.screenshots.length >= 1 && r.data.screenshots[0].data.startsWith('data:image/png'));

  // déterminisme : second scan => mêmes hash
  const scan2 = (await call('POST', `/claws/${claw.id}/scan`, { profileId: profile.id })).data;
  const scan2Done = await waitFor(`/scan-jobs/${scan2.id}`, (d) => d.status === 'succeeded');
  check('scan déterministe', JSON.stringify(scan2Done.results.map((x) => x.hash)) === JSON.stringify(scanDone.results.map((x) => x.hash)));

  // removal
  r = await call('POST', `/scan-results/${result.id}/removal`);
  const removal = r.data;
  check('lancement removal', r.status === 201 && !!removal.id);
  const remDone = await waitFor(`/removal-jobs/${removal.id}`, (d) => d.status === 'succeeded' || d.status === 'failed', 15000);
  check('removal succeeded avec 4 steps', remDone.status === 'succeeded' && remDone.steps.length === 4
    && remDone.steps.map((s) => s.type).join() === 'submit,verify,poll,done' && remDone.steps.every((s) => s.result?.status === 'ok'));
  r = await call('GET', '/removal-jobs');
  check('liste removal-jobs', r.data.length === 1);

  // axe
  const axeId = 'claude-ai';
  r = await call('POST', `/axes/${axeId}/connect`, {});
  check('connect sans displayName -> 400', r.status === 400);
  r = await call('POST', `/axes/${axeId}/connect`, { displayName: 'camille@claude' });
  const account = r.data;
  check('axe connect', r.status === 201 && account.status === 'connected');
  r = await call('GET', `/axes/${axeId}/accounts`);
  check('liste comptes', r.data.length === 1);
  r = await call('POST', `/axes/${axeId}/archive`, { accountId: account.id });
  const axeJob = r.data;
  check('archive lancée', r.status === 201 && !!axeJob.id);
  const axeDone = await waitFor(`/axe-jobs/${axeJob.id}`, (d) => d.status === 'succeeded' || d.status === 'failed');
  check('archive succeeded avec 5-20 things', axeDone.status === 'succeeded' && axeDone.things.length >= 5 && axeDone.things.length <= 20 && axeDone.totalItems === axeDone.things.length);

  // mark + delete-marked
  r = await call('POST', `/things/${axeDone.things[0].id}/mark`);
  check('mark thing', r.status === 200 && r.data.markedForDeletion === true);
  r = await call('POST', `/axe-jobs/${axeJob.id}/delete-marked`);
  check('delete-marked -> 1', r.status === 200 && r.data.deleted === 1);
  r = await call('GET', `/axe-jobs/${axeJob.id}`);
  check('totalDeleted = 1 et thing isDeleted', r.data.totalDeleted === 1 && r.data.things.filter((t) => t.isDeleted).length === 1);
  r = await call('POST', `/axe-jobs/${axeJob.id}/delete-marked`);
  check('delete-marked idempotent -> 0', r.data.deleted === 0);

  // schedules + scheduler
  r = await call('POST', '/schedules', { kind: 'scan', targetId: 'x', cron: 'nimporte quoi' });
  check('schedule cron invalide -> 400', r.status === 400);
  r = await call('POST', '/schedules', { kind: 'scan', targetId: `${profile.id}:${claws[1].id}`, cron: '@every 1s' });
  const schedule = r.data;
  check('création schedule', r.status === 201 && schedule.enabled === true && schedule.nextRunAt > Date.now() - 50);
  engine.startScheduler(300);
  const sch = await waitFor('/schedules', (d) => d.find((s) => s.id === schedule.id)?.lastRunAt != null, 6000);
  engine.stopScheduler();
  check('scheduler a exécuté le schedule', sch.find((s) => s.id === schedule.id)?.lastRunAt != null);
  r = await call('GET', '/scan-jobs');
  check('scan déclenché par schedule', r.data.some((j) => j.trigger === 'schedule' && j.clawId === claws[1].id));
  r = await call('DELETE', `/schedules/${schedule.id}`);
  check('suppression schedule', r.status === 200 && r.data.ok === true);
  r = await call('DELETE', `/schedules/${schedule.id}`);
  check('suppression schedule inconnu -> 404', r.status === 404);

  // export
  r = await call('GET', '/export?format=csv');
  let text = await r.res.text();
  check('export csv', r.status === 200 && /attachment/.test(r.res.headers.get('content-disposition')) && text.startsWith('id,clawName') && text.split('\r\n').length > 2);
  r = await call('GET', '/export?format=json');
  const exp = r.data; // call() a déjà parsé le JSON
  check('export json', r.status === 200 && exp.profiles.length === 1 && exp.scanResults.length >= 2 && exp.removalJobs[0].steps.length === 4);
  r = await call('GET', '/export?format=zip');
  const zip = Buffer.from(await r.res.arrayBuffer());
  check('export zip (signature PK, 5 entrées)', r.status === 200 && zip.readUInt32LE(0) === 0x04034b50 && zip.readUInt16LE(zip.length - 12) === 5
    && zip.includes(Buffer.from('scan-results.csv')));
  r = await call('GET', '/export?format=xml');
  check('export format inconnu -> 400', r.status === 400);

  // events + settings
  r = await call('GET', '/events?limit=5');
  check('events limit', r.status === 200 && r.data.length === 5);
  r = await call('PATCH', '/settings', { theme: 'light' });
  check('settings patch', r.status === 200 && r.data.theme === 'light' && r.data.mode === 'demo');
  r = await call('PATCH', '/settings', { theme: 'rose' });
  check('settings theme invalide -> 400', r.status === 400);
  r = await call('GET', '/settings');
  check('settings persistés', r.data.theme === 'light');

  // scan massif : un scanJob par claw activé
  check('catalogue >= 80 brokers, catégories variées', claws.length >= 80 && new Set(claws.map((c) => c.category)).size >= 6);
  r = await call('POST', '/claws/scan-all', {});
  check('scan-all sans profil -> 400', r.status === 400 && !!r.data.error);
  r = await call('POST', '/claws/scan-all', { profileId: 'inconnu' });
  check('scan-all profil inconnu -> 400', r.status === 400);
  const bulkProfile = (await call('POST', '/profiles', { primaryName: 'Lou Bernard' })).data;
  r = await call('POST', '/claws/scan-all', { profileId: bulkProfile.id });
  const enabledCount = claws.filter((c) => c.enabled !== false).length;
  check('scan-all crée un job par claw', r.status === 201 && r.data.total === enabledCount && r.data.jobIds.length === enabledCount);
  const bulkJobs = (await call('GET', '/scan-jobs')).data.filter((j) => j.profileId === bulkProfile.id);
  check('scan-all : jobs visibles dans /scan-jobs', bulkJobs.length === enabledCount && new Set(bulkJobs.map((j) => j.clawId)).size === enabledCount);
  r = await call('POST', '/claws/scan-all', { profileId: bulkProfile.id });
  check('scan-all relancé : scans actifs ignorés', r.status === 201 && r.data.total === 0);

  // suppression du profil (cascade)
  r = await call('DELETE', `/profiles/${profile.id}`);
  check('suppression profil', r.status === 200 && (await call('GET', `/profiles/${profile.id}`)).status === 404);
  r = await call('GET', '/inconnue');
  check('route inconnue -> 404 JSON', r.status === 404 && !!r.data.error);
} catch (e) {
  total++;
  console.log('  FAIL exception', e);
} finally {
  engine.stopAll();
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`${pass === total ? 'PASS' : 'FAIL'} ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
