// Entry point: Hono app, /api routes, static web/dist (SPA fallback).
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.mjs';
import { buildRoutes } from './routes.mjs';
import { recoverInterrupted } from './repo.mjs';
import { initDiscord, discordRouter, securityInfo } from './discord/index.mjs';
import { initImport, importRouter } from './import/index.mjs';
import { socialRouter } from './social/index.mjs';
import { updateRouter } from './update/index.mjs';
import { tiktokRouter } from './social/tiktok.mjs';
import { installNetworkGuard, privacyRouter } from './privacy.mjs';
import { securityMiddleware } from './security.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// WEB_DIST_DIR lets packaging (exe) override the static directory.
const WEB_DIST = process.env.WEB_DIST_DIR
  ? resolve(process.env.WEB_DIST_DIR)
  : resolve(here, '..', '..', 'web', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

async function readIfFile(path) {
  try { return (await stat(path)).isFile() ? await readFile(path) : null; } catch { return null; }
}

export function createApp({ webDist = WEB_DIST } = {}) {
  const db = getDb(); // open database and run migrations
  installNetworkGuard(db); // network lock (offline by default)
  recoverInterrupted();
  initDiscord(db); // tables and optional resumption of disappearing mode
  initImport(db); // Discord export / Forget Engine database import tables

  const app = new Hono();
  app.use('*', securityMiddleware()); // DNS rebinding, CSRF, security headers: BEFORE any route
  app.route('/api', buildRoutes());
  app.route('/api/privacy', privacyRouter(db));
  app.route('/api/discord', discordRouter()); // before the wildcard 404
  app.route('/api/import', importRouter(db));
  app.route('/api/social', socialRouter(db));
  app.route('/api/update', updateRouter(db));
  app.route('/api/tiktok', tiktokRouter(db));
  app.get('/api/security', (c) => c.json(securityInfo()));
  app.all('/api/*', (c) => c.json({ error: 'route not found' }, 404)); // the sub-app's notFound handler is not inherited

  app.get('*', async (c) => {
    const index = await readIfFile(join(webDist, 'index.html'));
    if (!index) return c.json({ error: 'web/dist absent - lance npm run build' }, 503);
    let decoded;
    try { decoded = decodeURIComponent(new URL(c.req.url).pathname); } catch { return c.json({ error: 'invalid path' }, 400); }
    if (decoded.includes('\0')) return c.json({ error: 'invalid path' }, 400);
    const root = resolve(webDist);
    const rel = normalize(decoded).replace(/^[/\\]+/, '');
    const full = resolve(root, rel);
    if (full === root || !full.startsWith(root + sep)) {
      return new Response(index, { headers: { 'Content-Type': MIME['.html'] } });
    }
    const file = await readIfFile(full);
    if (file) return new Response(file, { headers: { 'Content-Type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream' } });
    // SPA fallback, except missing assets (with extensions): 404.
    if (extname(full)) return c.json({ error: 'file not found' }, 404);
    return new Response(index, { headers: { 'Content-Type': MIME['.html'] } });
  });
  return app;
}

// Start only when launched directly (node src/index.mjs).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { startScheduler } = await import('./engine.mjs');
  const { stopDiscord } = await import('./discord/index.mjs');
  const port = Number(process.env.PORT) || 4173;
  const app = createApp();
  startScheduler();
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
    console.log(`Forget (demo) : http://127.0.0.1:${info.port}`);
  });
  const shutdown = () => {
    try { stopDiscord(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
