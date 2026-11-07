// Discord engine (manage YOUR OWN account, 100% local).
// Only network destinations: https://discord.com/api/v10 and the Discord gateway (see http.mjs / gateway.mjs).
import * as store from './store.mjs';
import { buildDiscordRouter } from './routes.mjs';
import { startDisappearing, stopDisappearing } from './gateway.mjs';
import { cancelAllJobs } from './bulk.mjs';
import { startPurgeScheduler, stopPurgeScheduler } from './purge.mjs';

let initializedDb = null;

/** Create tables and resume disappearing mode. Idempotent: called on every createApp(). */
export function initDiscord(db) {
  if (initializedDb === db) return db; // already done: no duplicate migration or gateway
  stopDisappearing();
  stopPurgeScheduler();
  store.initStore(db);
  store.markInterrupted(); // jobs left active by a previous process
  initializedDb = db;
  startPurgeScheduler(); // resume active purges (cursor stored in the database)
  const cfg = store.getDisappearing();
  if (cfg.enabled && store.getToken()) startDisappearing();
  return db;
}

export function discordRouter() {
  return buildDiscordRouter();
}

/** C2: token encryption status for GET /api/security. */
export function securityInfo() {
  return { tokenEncrypted: store.isTokenEncrypted(), cipher: store.cipherKind(), archivePlaintext: true };
}

/** Clean shutdown: close the gateway and request cancellation of running jobs. */
export function stopDiscord() {
  stopDisappearing();
  stopPurgeScheduler();
  cancelAllJobs();
  initializedDb = null;
}

// Re-export for tests.
export { setTransport, resetTransport } from './http.mjs';
export { waitForJob, waitAllJobs } from './bulk.mjs';
export { waitForPurge, waitAllPurges, tickPurges } from './purge.mjs';
