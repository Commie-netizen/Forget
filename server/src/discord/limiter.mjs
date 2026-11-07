// One scheduler per credential, shared by every REST caller. No credentials in telemetry.
export class RateLimiter {
  constructor({ now = () => performance.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), cap = 25, margin = 40, fallback = 300 } = {}) {
    Object.assign(this, { now, sleep, cap, margin, fallback });
    this.routes = new Map(); this.buckets = new Map(); this.queue = [];
    this.starts = []; this.globalUntil = 0; this.requests = 0; this.limited = 0;
  }
  route(method, path) {
    const parts = path.split('/');
    const major = ['channels', 'guilds', 'webhooks'].includes(parts[1]) ? parts[2] : 'none';
    const normalized = parts.map((p, i) => i === 2 && major !== 'none' ? ':major' : /^\d+$/.test(p) ? ':id' : p).join('/');
    return { key: `${method}:${normalized}:${major}`, major };
  }
  bucket(route) {
    const key = this.routes.get(route.key) || route.key;
    if (!this.buckets.has(key)) this.buckets.set(key, { busy: false, until: 0, remaining: null, reset: 0 });
    return this.buckets.get(key);
  }
  run(method, path, fn, shouldStop = () => false) {
    return new Promise((resolve, reject) => {
      this.queue.push({ route: this.route(method, path), fn, resolve, reject, shouldStop });
      this.pump();
    });
  }
  pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const now = this.now();
      this.starts = this.starts.filter(t => t > now - 1000);
      for (let i = 0; i < this.queue.length;) {
        const task = this.queue[i], b = this.bucket(task.route);
        if (task.shouldStop()) {
          this.queue.splice(i, 1); task.reject(Object.assign(new Error('Operation cancelled'), { status: 499 })); continue;
        }
        if (b.busy || now < Math.max(this.globalUntil, b.until) || this.starts.length >= this.cap) { i++; continue; }
        this.queue.splice(i, 1); b.busy = true; this.starts.push(now); this.requests++;
        Promise.resolve().then(task.fn).then(result => {
          this.observe(task.route, b, result);
          task.resolve(result);
        }, task.reject).finally(() => { b.busy = false; this.pump(); });
      }
      // Poll only while queued: also makes cancellation responsive during long cooldowns.
      if (this.queue.length && !this.waking) {
        this.waking = true;
        const deadlines = this.queue.map(t => Math.max(this.globalUntil, this.bucket(t.route).until,
          this.starts.length >= this.cap ? this.starts[0] + 1000 : 0));
        const wait = Math.max(1, Math.min(100, ...deadlines.map(t => t > now ? t - now : 100)));
        this.sleep(wait).then(() => { this.waking = false; this.pump(); });
      }
    } finally { this.pumping = false; }
  }
  observe(route, original, { res, data }) {
    const now = this.now(), h = name => res.headers?.get?.(name);
    const number = name => { const v = h(name); return v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null; };
    const hash = h('x-ratelimit-bucket');
    let b = original;
    if (hash) {
      const key = `${hash}:${route.major}`;
      this.routes.set(route.key, key);
      if (!this.buckets.has(key)) this.buckets.set(key, original);
      b = this.buckets.get(key);
    }
    const remaining = number('x-ratelimit-remaining'), reset = number('x-ratelimit-reset-after');
    if (remaining !== null && reset !== null && remaining >= 0 && reset >= 0) {
      b.remaining = remaining; b.reset = now + reset * 1000 + this.margin;
      b.until = Math.max(b.until, remaining === 0 ? b.reset : now);
    } else {
      b.until = Math.max(b.until, now + this.fallback);
    }
    if (res.status === 429) {
      this.limited++;
      const waits = [Number(data?.retry_after), number('retry-after')].filter(v => v !== null && Number.isFinite(v) && v >= 0);
      const until = now + (waits.length ? Math.max(...waits) : 1) * 1000 + this.margin;
      b.until = Math.max(b.until, until);
      if (data?.global || h('x-ratelimit-global') === 'true' || h('x-ratelimit-scope') === 'global') this.globalUntil = Math.max(this.globalUntil, until);
    }
    // A route can be rediscovered while another route in its bucket is in flight.
    original.until = Math.max(original.until, b.until);
  }
  snapshot() {
    const now = this.now();
    return { queued: this.queue.length, requests: this.requests, rateLimited: this.limited,
      globalWaitMs: Math.max(0, Math.ceil(this.globalUntil - now)), cap: this.cap,
      waitingBuckets: [...new Set(this.buckets.values())].filter(b => b.until > now).length };
  }
}
