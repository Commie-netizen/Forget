// Single-executable entry point (Node SEA). Embedded UI assets, database in %APPDATA%.
// Outside SEA (node server/src/standalone.mjs): serve web/dist from disk.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import sea from 'node:sea';
import { createApp } from './index.mjs';
import { startScheduler } from './engine.mjs';
import { stopDiscord } from './discord/index.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

function parseArgs(argv) {
  const out = { open: true, port: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') out.open = false;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const port = args.port || Number(process.env.PORT) || 4173;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: ${port}`);
  process.exit(2);
}

if (!process.env.FORGET_DB_PATH) {
  const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  process.env.FORGET_DB_PATH = join(base, 'forget-desktop', 'data', 'forget.sqlite');
}

if (process.env.FORGET_DEBUG) {
  const probes = {};
  for (const [label, p] of [
    ['temp', join(process.env.TEMP || 'C:\\Windows\\Temp', 'forget-probe.txt')],
    ['appdata', join(process.env.APPDATA || homedir(), 'forget-probe.txt')],
    ['execdir', join(dirname(process.execPath), 'forget-probe.txt')],
  ]) {
    try {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, 'ok');
      unlinkSync(p);
      probes[label] = 'OK';
    } catch (e) {
      probes[label] = `${e.code || e.message}`;
    }
  }
  console.error('[debug] ' + JSON.stringify({
    cwd: process.cwd(),
    execPath: process.execPath,
    argv1: process.argv[1],
    appdata: process.env.APPDATA,
    temp: process.env.TEMP,
    db: process.env.FORGET_DB_PATH,
    isSea: sea.isSea(),
    meta: import.meta.url,
    probes,
  }));
}

const inner = createApp();
let app = inner;

if (sea.isSea()) {
  const files = JSON.parse(sea.getAsset('manifest.json', 'utf8')); // paths "assets/x.js", "index.html"
  const known = new Set(files);
  const send = (name) => new Response(sea.getRawAsset('web/' + name).slice(0), {
    headers: { 'Content-Type': MIME[extname(name).toLowerCase()] ?? 'application/octet-stream' },
  });
  app = new Hono();
  app.all('/api/*', (c) => inner.fetch(c.req.raw));
  app.get('*', (c) => {
    let rel;
    try { rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, ''); } catch { rel = ''; }
    if (known.has(rel)) return send(rel);
    if (extname(rel)) return c.json({ error: 'file not found' }, 404);
    return send('index.html'); // SPA fallback
  });
}

startScheduler();
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  const url = `http://127.0.0.1:${info.port}`;
  console.log(`Forget : ${url}`);
  console.log(`Base : ${process.env.FORGET_DB_PATH}`);
  if (args.open) {
    try { spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref(); } catch { /* ignore */ }
  }
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} deja utilise (essaie --port <n>)` : e.message);
  process.exit(1);
});

const shutdown = () => {
  try { stopDiscord(); } catch { /* ignore */ }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
