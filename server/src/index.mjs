// Entrée : app Hono, routes /api, statique web/dist (fallback SPA).
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
// WEB_DIST_DIR permet au packaging (exe) d'imposer un autre dossier statique.
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
  const db = getDb(); // ouvre la base + migrations
  installNetworkGuard(db); // verrou réseau (hors-ligne par défaut)
  recoverInterrupted();
  initDiscord(db); // tables + reprise éventuelle du mode disparition
  initImport(db); // tables d'import d'export Discord / base Forget Engine

  const app = new Hono();
  app.use('*', securityMiddleware()); // DNS rebinding, CSRF, en-têtes de sécurité : AVANT toute route
  app.route('/api', buildRoutes());
  app.route('/api/privacy', privacyRouter(db));
  app.route('/api/discord', discordRouter()); // avant le wildcard 404
  app.route('/api/import', importRouter(db));
  app.route('/api/social', socialRouter(db));
  app.route('/api/update', updateRouter(db));
  app.route('/api/tiktok', tiktokRouter(db));
  app.get('/api/security', (c) => c.json(securityInfo()));
  app.all('/api/*', (c) => c.json({ error: 'route introuvable' }, 404)); // le notFound du sous-app n'est pas hérité

  app.get('*', async (c) => {
    const index = await readIfFile(join(webDist, 'index.html'));
    if (!index) return c.json({ error: 'web/dist absent - lance npm run build' }, 503);
    let decoded;
    try { decoded = decodeURIComponent(new URL(c.req.url).pathname); } catch { return c.json({ error: 'chemin invalide' }, 400); }
    if (decoded.includes('\0')) return c.json({ error: 'chemin invalide' }, 400);
    const root = resolve(webDist);
    const rel = normalize(decoded).replace(/^[/\\]+/, '');
    const full = resolve(root, rel);
    if (full === root || !full.startsWith(root + sep)) {
      return new Response(index, { headers: { 'Content-Type': MIME['.html'] } });
    }
    const file = await readIfFile(full);
    if (file) return new Response(file, { headers: { 'Content-Type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream' } });
    // Fallback SPA, sauf pour les assets manquants (extension) : 404.
    if (extname(full)) return c.json({ error: 'fichier introuvable' }, 404);
    return new Response(index, { headers: { 'Content-Type': MIME['.html'] } });
  });
  return app;
}

// Démarrage seulement si lancé directement (node src/index.mjs).
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
