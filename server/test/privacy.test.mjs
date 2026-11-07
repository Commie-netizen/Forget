// Tests de la couche de confidentialité : autonomes, sans réseau externe.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'forget-privacy-'));
process.env.FORGET_DB_PATH = join(tmp, 'privacy.sqlite');

// Fetch de base factice installé AVANT le verrou : aucune requête réelle ne part.
const calls = [];
globalThis.fetch = async (input) => { calls.push(String(input?.url ?? input)); return new Response('ok'); };
const baseFetch = globalThis.fetch;

const { createApp } = await import('../src/index.mjs');
const { getNetworkStats, resetNetworkStats } = await import('../src/privacy.mjs');
const { closeDb } = await import('../src/db.mjs');

const app = createApp();
const wrapped = globalThis.fetch;
let pass = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) pass++; else console.log('FAIL', name);
}
const call = async (method, path, body) => {
  const r = await app.request(path, { method, headers: { 'content-type': 'application/json', 'x-forget-request': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
async function rejects(url) {
  try { await fetch(url); return null; } catch (e) { return e; }
}

check('fetch enveloppé', wrapped !== baseFetch);
createApp(); createApp();
check('pas de double enveloppe', globalThis.fetch === wrapped);

let r = await call('GET', '/api/privacy');
check('GET 200', r.status === 200);
check('offline par défaut', r.json.offline === true);
check('telemetry false + exits.forget false', r.json.telemetry === false && r.json.exits.forget === false);
check('allowed liste API explicites', r.json.allowed.includes('discord.com') && r.json.allowed.includes('api.x.com') && r.json.allowed.includes('oauth.reddit.com')
  && JSON.stringify([...r.json.allowed].sort()) === JSON.stringify(['api.github.com', 'api.x.com', 'cdn.discordapp.com', 'discord.com', 'gateway.discord.gg', 'github.com', 'media.discordapp.net', 'oauth.reddit.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'www.reddit.com']));
check('privacyNote', typeof r.json.privacyNote === 'string' && r.json.privacyNote.length > 0);

resetNetworkStats();
let e = await rejects('https://example.com/x');
check('example.com rejeté offline', e instanceof TypeError && e.message === 'offline mode: network blocked');
e = await rejects('https://discord.com/api');
check('discord rejeté offline', e instanceof TypeError && e.message === 'offline mode: network blocked');
check('stats bloquées = 2', getNetworkStats().blocked === 2);

check('127.0.0.1 autorisé offline', (await fetch('http://127.0.0.1:1/x')).ok && calls.at(-1) === 'http://127.0.0.1:1/x');
check('localhost autorisé offline', (await fetch('http://localhost:1/')).ok);
check('stats autorisées = 2', getNetworkStats().allowed === 2);
check('dernière destination', getNetworkStats().lastDestination === 'localhost');

r = await call('PATCH', '/api/privacy', { offline: false });
check('PATCH false 200', r.status === 200 && r.json.offline === false);
check('GET persisté false', (await call('GET', '/api/privacy')).json.offline === false);
const before = calls.length;
check('discord.com accepté online', (await fetch('https://discord.com/api/v9/users/@me')).ok && calls.length === before + 1);
check('cdn.discordapp.com accepté (URL)', (await fetch(new URL('https://cdn.discordapp.com/a.png'))).ok);
check('gateway accepté (Request)', (await fetch(new Request('https://gateway.discord.gg/'))).ok);
e = await rejects('https://example.com/');
check('example.com rejeté online', e instanceof TypeError && e.message === 'host not allowed: example.com');
e = await rejects('https://discord.com.evil.io/');
check('sous-domaine piège rejeté', e instanceof TypeError && e.message === 'host not allowed: discord.com.evil.io');
check('aucun appel inattendu', !calls.some((u) => u.includes('example.com') || u.includes('evil')));

r = await call('PATCH', '/api/privacy', { offline: true });
check('PATCH true 200', r.status === 200 && r.json.offline === true);
e = await rejects('https://discord.com/');
check('re-bloqué après PATCH true', e?.message === 'offline mode: network blocked');

for (const bad of [{ offline: 'yes' }, { offline: 1 }, {}, null]) {
  check(`PATCH invalide ${JSON.stringify(bad)} -> 400`, (await call('PATCH', '/api/privacy', bad)).status === 400);
}
check('état intact après 400', (await call('GET', '/api/privacy')).json.offline === true);

r = await call('POST', '/api/privacy/reset-stats');
check('reset ok', r.status === 200 && r.json.ok === true);
const s = getNetworkStats();
check('stats remises à zéro', s.blocked === 0 && s.allowed === 0 && s.lastDestination === null);

// Compatibilité mock : un fetch remplacé ensuite n'est pas cassé, et se re-enveloppe une seule fois.
const mock = async () => new Response('mock');
globalThis.fetch = mock;
check('mock postérieur conservé', globalThis.fetch === mock && (await fetch('https://example.com')).ok);
createApp();
check('réenveloppe le mock une fois', globalThis.fetch !== mock && (await rejects('https://example.com'))?.message === 'offline mode: network blocked');
const w2 = globalThis.fetch; createApp();
check('idempotent après mock', globalThis.fetch === w2);

closeDb();
console.log(pass === total ? `PASS ${pass}/${total}` : `FAIL ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
