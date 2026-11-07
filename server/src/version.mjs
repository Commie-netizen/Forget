// Single source for the application version (server, exported archive, update checks).
// __FORGET_UPDATE_REPO__ is injected by desktop/build.mjs (GITHUB_REPOSITORY in CI); otherwise use the environment variable.
export const VERSION = '4.3.0';
/* global __FORGET_UPDATE_REPO__ */
const injected = typeof __FORGET_UPDATE_REPO__ === 'string' ? __FORGET_UPDATE_REPO__ : '';
export const DEFAULT_UPDATE_REPO = process.env.FORGET_UPDATE_REPO || injected || '';
export const USER_AGENT = `Forget/${VERSION} (windows; personal cleanup)`;
