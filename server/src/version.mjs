// Source unique de la version applicative (serveur, archive exportée, vérification des mises à jour).
// __FORGET_UPDATE_REPO__ est injecté par desktop/build.mjs (GITHUB_REPOSITORY en CI) ; sinon variable d'env.
export const VERSION = '4.3.0';
/* global __FORGET_UPDATE_REPO__ */
const injected = typeof __FORGET_UPDATE_REPO__ === 'string' ? __FORGET_UPDATE_REPO__ : '';
export const DEFAULT_UPDATE_REPO = process.env.FORGET_UPDATE_REPO || injected || '';
export const USER_AGENT = `Forget/${VERSION} (windows; personal cleanup)`;
