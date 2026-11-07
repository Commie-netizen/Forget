// Entree du serveur embarque (bundlee par build.mjs). Ecoute uniquement sur 127.0.0.1.
import { serve } from '@hono/node-server';
import { createApp } from '../server/src/index.mjs';
import { startScheduler, stopScheduler } from '../server/src/engine.mjs';
import { stopDiscord } from '../server/src/discord/index.mjs';

export function startServer({ webDist }) {
  const app = createApp({ webDist });
  startScheduler();
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({
        port: info.port,
        close() {
          try { stopScheduler(); } catch { /* ignore */ }
          try { stopDiscord(); } catch { /* ignore */ }
          try { server.close(); server.closeAllConnections?.(); } catch { /* ignore */ }
        },
      });
    });
    server.on('error', reject);
  });
}
