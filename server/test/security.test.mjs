// Local server security: CSRF, DNS rebinding, headers, CSV injection, hostile ZIP archives.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { zipSync, strToU8 } from 'fflate';
import { rejectReason, securityMiddleware, CSP } from '../src/security.mjs';
import { csvCell } from '../src/csv.mjs';
import { zipEntries } from '../src/import/zipread.mjs';

let pass = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); pass++; results.push(`  ok   ${name}`); } catch (e) { results.push(`  FAIL ${name}\n       ${e.stack || e.message}`); }
}
const base = { method: 'GET', host: '127.0.0.1:4173', origin: undefined, secFetchSite: undefined, marker: undefined };

await check('guard: legitimate requests accepted (UI, Vite proxy, local tools)', () => {
  assert.equal(rejectReason(base), null);
  assert.equal(rejectReason({ ...base, method: 'POST', origin: 'http://127.0.0.1:4173', secFetchSite: 'same-origin', marker: '1' }), null);
  assert.equal(rejectReason({ ...base, method: 'POST', host: 'localhost:5173', origin: 'http://localhost:5173', marker: '1' }), null);
  assert.equal(rejectReason({ ...base, host: '[::1]:4173' }), null);
  assert.equal(rejectReason({ ...base, secFetchSite: 'none' }), null); // direct navigation
});

await check('guard: DNS rebinding (non-local Host) refused', () => {
  assert.match(rejectReason({ ...base, host: 'evil.example:4173' }), /host/);
  assert.match(rejectReason({ ...base, host: '127.0.0.1.evil.example' }), /host/);
  assert.match(rejectReason({ ...base, host: '' }), /host/);
});

await check('guard: CSRF from a third-party site refused (Origin, Sec-Fetch-Site, missing header)', () => {
  assert.match(rejectReason({ ...base, method: 'POST', origin: 'https://evil.example', marker: '1' }), /origin/);
  assert.match(rejectReason({ ...base, method: 'POST', origin: 'http://127.0.0.1:9999', marker: '1' }), /origin/); // another local port
  assert.match(rejectReason({ ...base, method: 'POST', origin: 'null', marker: '1' }), /opaque/);
  assert.match(rejectReason({ ...base, secFetchSite: 'cross-site' }), /cross-site/);
  assert.match(rejectReason({ ...base, secFetchSite: 'same-site' }), /cross-site/);
  assert.match(rejectReason({ ...base, method: 'POST' }), /X-Forget-Request/); // form / text/plain without header
  assert.match(rejectReason({ ...base, method: 'DELETE', marker: 'yes' }), /X-Forget-Request/);
});

await check('middleware: 403 before the route, no CORS header, security headers present', async () => {
  let reached = 0;
  const app = new Hono();
  app.use('*', securityMiddleware());
  app.post('/api/x', (c) => { reached++; return c.json({ ok: true }); });
  app.get('/', (c) => c.html('<p>ok</p>'));
  const evil = await app.request('http://127.0.0.1/api/x', { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(evil.status, 403); assert.equal(reached, 0);
  const pre = await app.request('http://127.0.0.1/api/x', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
  const ok = await app.request('http://127.0.0.1/api/x', { method: 'POST', headers: { 'X-Forget-Request': '1' } });
  assert.equal(ok.status, 200); assert.equal(reached, 1);
  assert.equal(ok.headers.get('access-control-allow-origin'), null);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const page = await app.request('http://127.0.0.1/');
  assert.equal(page.headers.get('content-security-policy'), CSP);
  assert.match(CSP, /script-src 'self'(;|$)/); assert.match(CSP, /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
});

await check('CSV: formulas neutralized, normal values intact', () => {
  for (const f of ['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd']) assert(csvCell(f).replace(/^"/, '').startsWith("'"), f);
  assert.equal(csvCell('bonjour'), 'bonjour');
  assert.equal(csvCell(-5), '-5'); // number: not an entered string
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell(null), '');
});

const dir = mkdtempSync(join(tmpdir(), 'forget-sec-'));
try {
  await check('ZIP: skipped entries never decompressed, ZIP bomb stopped by limits', async () => {
    const big = new Uint8Array(40 * 1024 * 1024); // 40 MB of zeros, a few KB compressed
    const zip = zipSync({
      'activity/huge.json': big,
      'messages/c123/messages.json': strToU8('[{"ID":"1","Timestamp":"2024-01-01","Contents":"x"}]'),
      'messages/c456/messages.json': big,
      '../../evil/messages/c1/messages.json': strToU8('[]'),
    }, { level: 9 });
    const file = join(dir, 'export.zip');
    writeFileSync(file, zip);
    const want = (n) => /(?:^|\/)messages\/c?\d+\/messages\.json$/.test(n);
    const seen = [];
    await assert.rejects(async () => {
      for await (const e of zipEntries(file, want, { maxEntry: 8 * 1024 * 1024, tooBig: 'trop gros' })) seen.push([e.name, e.data.length]);
    }, /trop gros/);
    assert.deepEqual(seen.map((x) => x[0]), ['messages/c123/messages.json']); // the large ignored file was not read
    // The "../../" name is only a label: no files are written to disk.
    const all = [];
    for await (const e of zipEntries(file, (n) => n.includes('evil'))) all.push(e.name);
    assert.deepEqual(all, ['../../evil/messages/c1/messages.json']);
  });

  await check('ZIP: corrupted or truncated archive cleanly refused', async () => {
    const bad = join(dir, 'bad.zip');
    writeFileSync(bad, Buffer.from('PK not an archive'));
    await assert.rejects(async () => { for await (const _ of zipEntries(bad, () => true)); }, /Invalid ZIP/);
    const zip = zipSync({ 'messages/c1/messages.json': strToU8('[]'.repeat(1000)) });
    const cut = join(dir, 'cut.zip');
    writeFileSync(cut, Buffer.from(zip).subarray(0, zip.length - 10));
    await assert.rejects(async () => { for await (const _ of zipEntries(cut, () => true)); });
  });
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(results.join('\n'));
console.log(pass === results.length ? `PASS ${pass}/${results.length}` : `FAIL ${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 1);
