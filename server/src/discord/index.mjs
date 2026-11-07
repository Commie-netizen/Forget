// Moteur Discord (gestion de SON PROPRE compte, 100 % local).
// Seules destinations réseau : https://discord.com/api/v10 et le gateway Discord (voir http.mjs / gateway.mjs).
import * as store from './store.mjs';
import { buildDiscordRouter } from './routes.mjs';
import { startDisappearing, stopDisappearing } from './gateway.mjs';
import { cancelAllJobs } from './bulk.mjs';
import { startPurgeScheduler, stopPurgeScheduler } from './purge.mjs';

let initializedDb = null;

/** Crée les tables et reprend le mode disparition. Idempotent : appelé à chaque createApp(). */
export function initDiscord(db) {
  if (initializedDb === db) return db; // déjà fait : ni double migration ni double gateway
  stopDisappearing();
  stopPurgeScheduler();
  store.initStore(db);
  store.markInterrupted(); // jobs restés actifs d'un process précédent
  initializedDb = db;
  startPurgeScheduler(); // reprise des purges actives (curseur en base)
  const cfg = store.getDisappearing();
  if (cfg.enabled && store.getToken()) startDisappearing();
  return db;
}

export function discordRouter() {
  return buildDiscordRouter();
}

/** C2 : état du chiffrement du token pour GET /api/security. */
export function securityInfo() {
  return { tokenEncrypted: store.isTokenEncrypted(), cipher: store.cipherKind(), archivePlaintext: true };
}

/** Arrêt propre : ferme le gateway, demande l'annulation des jobs en cours. */
export function stopDiscord() {
  stopDisappearing();
  stopPurgeScheduler();
  cancelAllJobs();
  initializedDb = null;
}

// Réexport utile aux tests.
export { setTransport, resetTransport } from './http.mjs';
export { waitForJob, waitAllJobs } from './bulk.mjs';
export { waitForPurge, waitAllPurges, tickPurges } from './purge.mjs';
