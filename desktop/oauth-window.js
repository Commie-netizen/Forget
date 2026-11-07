'use strict';
// Fenetre OAuth : page d'autorisation officielle (X ou Reddit). L'utilisateur s'y connecte lui-meme ;
// Forget ne lit ni mot de passe ni cookie. La redirection vers l'URL de retour est interceptee et annulee :
// seul le parametre `code` (et `state`) est transmis au serveur local, qui fait l'echange de jeton.
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
  if (inFlight) return Promise.resolve({ error: 'Une fenetre de connexion est deja ouverte' });
  const domains = DOMAINS[provider];
  if (!domains || !isHost(authorizeUrl, domains)) return Promise.reject(new Error('Fournisseur OAuth invalide'));
  inFlight = new Promise((resolve) => {
    let done = false;
    const win = new BrowserWindow({
      width: 560, height: 780, title: `Forget - connexion ${provider === 'twitter' ? 'X' : 'Reddit'}`, autoHideMenuBar: true,
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
    // Les ressources de la page du fournisseur passent ; la redirection de retour est capturee puis annulee.
    ses.webRequest.onBeforeRequest((details, cb) => {
      if (details.url.startsWith(redirectUri)) { cb({ cancel: true }); finish({ url: details.url }); return; }
      const ok = isOnline() && (details.url.startsWith('https:') || details.url.startsWith('data:') || details.url.startsWith('blob:'));
      cb({ cancel: !ok });
    });
    const guard = (e, url) => {
      if (url.startsWith(redirectUri)) { e.preventDefault(); finish({ url }); return; }
      if (!isHost(url, domains)) e.preventDefault(); // navigation principale limitee au fournisseur
    };
    win.webContents.on('will-navigate', guard);
    win.webContents.on('will-redirect', guard);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => finish({ cancelled: true }));
    win.loadURL(authorizeUrl).catch(() => { /* annulation de la redirection finale : attendu */ });
  });
  return inFlight;
};
