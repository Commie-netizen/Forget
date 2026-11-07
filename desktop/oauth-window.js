'use strict';
// OAuth window: official authorization page (X or Reddit). The user logs in directly;
// Forget reads neither passwords nor cookies. The callback redirect is intercepted and cancelled:
// only the code parameter (and state) is passed to the local server for token exchange.
const { BrowserWindow } = require('electron');
const { isOnline } = require('./social-windows.js');

const DOMAINS = { twitter: ['x.com', 'twitter.com'], reddit: ['reddit.com'] };
const isHost = (url, domains) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && domains.some((d) => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch { return false; }
};

let inFlight = null;
exports.runOAuthWindow = function runOAuthWindow({ provider, authorizeUrl, redirectUri }) {
  if (inFlight) return Promise.resolve({ error: 'A login window is already open' });
  const domains = DOMAINS[provider];
  if (!domains || !isHost(authorizeUrl, domains)) return Promise.reject(new Error('Invalid OAuth provider'));
  inFlight = new Promise((resolve) => {
    let done = false;
    const win = new BrowserWindow({
      width: 560, height: 780, title: `Forget - ${provider === 'twitter' ? 'X' : 'Reddit'} login`, autoHideMenuBar: true,
      webPreferences: { partition: `persist:forget-oauth-${provider}`, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false },
    });
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      inFlight = null;
      if (!win.isDestroyed()) win.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ cancelled: true }), 10 * 60 * 1000);
    const ses = win.webContents.session;
    ses.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    // Allow provider page resources; capture and cancel the callback redirect.
    ses.webRequest.onBeforeRequest((details, cb) => {
      if (details.url.startsWith(redirectUri)) { cb({ cancel: true }); finish({ url: details.url }); return; }
      const ok = isOnline() && (details.url.startsWith('https:') || details.url.startsWith('data:') || details.url.startsWith('blob:'));
      cb({ cancel: !ok });
    });
    const guard = (e, url) => {
      if (url.startsWith(redirectUri)) { e.preventDefault(); finish({ url }); return; }
      if (!isHost(url, domains)) e.preventDefault(); // main navigation restricted to the provider
    };
    win.webContents.on('will-navigate', guard);
    win.webContents.on('will-redirect', guard);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => finish({ cancelled: true }));
    win.loadURL(authorizeUrl).catch(() => { /*final redirect cancellation: expected */ });
  });
  return inFlight;
};
