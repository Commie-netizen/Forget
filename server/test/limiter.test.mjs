import assert from 'node:assert/strict';
import { RateLimiter } from '../src/discord/limiter.mjs';
const response = (status = 204, headers = {}, data = null) => ({ res: new Response(null, { status, headers }), data });
const setup = () => {
  let now = 0;
  const limiter = new RateLimiter({ now: () => now, sleep: ms => new Promise(r => setImmediate(() => { now += ms; r(); })), margin: 40, fallback: 300, cap: 25 });
  return { limiter, time: () => now };
};
{
  const { limiter: l, time } = setup();
  await l.run('DELETE', '/channels/1/messages/11', () => response(204, { 'X-RateLimit-Bucket': 'delete', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '.5' }));
  let a, b;
  await Promise.all([
    l.run('DELETE', '/channels/1/messages/12', () => { a = time(); return response(); }),
    l.run('DELETE', '/channels/2/messages/13', () => { b = time(); return response(); }),
  ]);
  assert(a >= 540); assert(b < a); // independent major resource proceeds
}
{
  const { limiter: l, time } = setup();
  await l.run('GET', '/channels/1/messages', () => response(429, { 'Retry-After': '.8', 'X-RateLimit-Scope': 'global' }, { retry_after: .5, global: true }));
  const times = [];
  await Promise.all([1, 2, 3].map(i => l.run('DELETE', `/channels/${i}/messages/12`, () => { times.push(time()); return response(); })));
  assert(times.every(t => t >= 840));
  assert.equal(l.snapshot().rateLimited, 1);
}
{
  const { limiter: l, time } = setup();
  const starts = [];
  await Promise.all(Array.from({ length: 60 }, (_, i) => l.run('GET', `/channels/${i}/messages`, () => { starts.push(time()); return response(); })));
  for (const t of starts) assert(starts.filter(s => s > t - 1000 && s <= t).length <= 25);
}
{
  const { limiter: l, time } = setup();
  const h = { 'X-RateLimit-Bucket': 'shared', 'X-RateLimit-Remaining': '1', 'X-RateLimit-Reset-After': '.5' };
  await l.run('GET', '/channels/1/messages', () => response(200, h));
  await l.run('DELETE', '/channels/1/messages/11', () => response(204, { ...h, 'X-RateLimit-Remaining': '0' }));
  let start;
  await l.run('GET', '/channels/1/messages', () => { start = time(); return response(200); });
  assert(start >= 540);
}
{
  const { limiter: l } = setup(); let calls = 0;
  await assert.rejects(l.run('DELETE', '/channels/1/messages/11', () => { calls++; return response(); }, () => true), /cancelled/);
  assert.equal(calls, 0);
}
console.log('PASS limiter: bucket deadlines, independent channels, global 429, rolling cap, shared routes, cancellation');
