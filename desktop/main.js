'use strict';
const { app, BrowserWindow, Menu, session, safeStorage, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const argv = process.argv.slice(1);
const smoke = argv.includes('--smoke');
const smokeOutIdx = argv.indexOf('--smoke-out');
const smokeOut = smokeOutIdx >= 0 ? argv[smokeOutIdx + 1] : null;
const dev = process.env.FORGET_DEV === '1';

app.setName('Forget');
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter,OptimizationHints');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('no-proxy-server');

// FORGET_APPDATA_DIR (tests uniquement) remplace %APPDATA%.
const appDataDir = process.env.FORGET_APPDATA_DIR || app.getPath('appData');
const forgetDb = path.join(appDataDir, 'forget-desktop', 'data', 'forget.sqlite');
if (smoke) {
  // Le smoke ne touche pas aux donnees de l'utilisateur : base jetable.
  process.env.FORGET_DB_PATH = path.join(app.getPath('temp'), `forget-smoke-${process.pid}.sqlite`);
} else if (!process.env.FORGET_DB_PATH) {
  process.env.FORGET_DB_PATH = forgetDb;
}
fs.mkdirSync(path.dirname(process.env.FORGET_DB_PATH), { recursive: true });

let server = null;
let win = null;
let splash = null;
let splashTimer = null;
let splashShownAt = 0; // pour le hold de test (FORGET_SPLASH_HOLD_MS)

// Splash : charge en data: URL (le filtre reseau de la session par defaut n'autorise pas file://).
function openSplash() {
  splashShownAt = Date.now();
  splash = new BrowserWindow({
    width: 480, height: 360, frame: false, resizable: false, show: false,
    backgroundColor: '#0b0d10', skipTaskbar: true, alwaysOnTop: true, title: 'Forget',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false },
  });
  splash.once('ready-to-show', () => { if (splash) splash.show(); });
  splash.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  splash.webContents.on('will-navigate', (e) => e.preventDefault());
  splash.on('closed', () => { splash = null; });
  try {
    const html = fs.readFileSync(path.join(__dirname, 'splash.html'));
    splash.loadURL('data:text/html;charset=utf-8;base64,' + html.toString('base64'));
  } catch (e) { console.error('splash', e); }
  splashTimer = setTimeout(closeSplash, 15000); // fallback
}

function closeSplash() {
  if (splashTimer) { clearTimeout(splashTimer); splashTimer = null; }
  if (splash) { try { splash.destroy(); } catch { /* ignore */ } splash = null; }
}

// Connexion Discord integree : fenetre isolee, lit uniquement le localStorage de discord.com.
function isDiscordHost(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && (x.hostname === 'discord.com' || x.hostname.endsWith('.discord.com'));
  } catch { return false; }
}
function isDiscordAppUrl(u) {
  if (!isDiscordHost(u)) return false;
  const p = new URL(u).pathname;
  return p === '/app' || p.startsWith('/app/') || p.startsWith('/channels/');
}

let loginInFlight = null;
function openDiscordLogin() {
  if (loginInFlight) return loginInFlight;
  loginInFlight = new Promise((resolve) => {
    let done = false;
    let timer = null;
    let checking = false;
    const lw = new BrowserWindow({
      width: 520, height: 760, parent: win || undefined, modal: !!win, title: 'Connexion Discord',
      backgroundColor: '#0b0d10', autoHideMenuBar: true, minimizable: false,
      icon: path.join(__dirname, 'assets', 'icon.ico'),
      webPreferences: {
        partition: 'persist:forget-discord-login',
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: dev,
      },
    });
    const wc = lw.webContents;
    // Pas de prompts Windows Hello / WebAuthn / notifications pendant la connexion.
    try {
      wc.session.setPermissionRequestHandler((_w, _p, cb) => cb(false));
      wc.session.setPermissionCheckHandler(() => false);
    } catch { /* ignore */ }
    lw.setMenu(null);
    const guard = (e, url) => { if (!isDiscordHost(url)) e.preventDefault(); };
    const finish = (result, close) => {
      if (done) return;
      done = true;
      if (timer) { clearInterval(timer); timer = null; }
      if (!wc.isDestroyed()) {
        wc.removeListener('did-navigate', check);
        wc.removeListener('did-navigate-in-page', check);
        wc.removeListener('did-finish-load', check);
        wc.removeListener('will-navigate', guard);
        wc.removeListener('will-redirect', guard);
      }
      lw.removeListener('closed', onClosed);
      loginInFlight = null;
      if (close && !lw.isDestroyed()) lw.close();
      resolve(result);
    };
    const onClosed = () => finish({ cancelled: true }, false);
    async function check() {
      if (done || checking || wc.isDestroyed() || !isDiscordAppUrl(wc.getURL())) return;
      checking = true;
      try {
        const raw = await wc.executeJavaScript("localStorage.getItem('token')", true);
        // Discord stocke le token entre guillemets (JSON) dans localStorage.
        let token = typeof raw === 'string' ? raw : '';
        try { const j = JSON.parse(token); if (typeof j === 'string') token = j; } catch { /* valeur brute */ }
        token = token.trim();
        if (token) {
          // Le token est transmis au serveur (chiffre DPAPI) : la session web Discord n'a pas a rester sur disque.
          wc.session.clearStorageData().catch(() => { /* best effort */ });
          finish({ token }, true);
        }
      } catch { /* page pas prete : nouvel essai au prochain evenement/tick */ } finally { checking = false; }
    }
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('did-navigate', check);
    wc.on('did-navigate-in-page', check);
    wc.on('did-finish-load', check);
    lw.on('closed', onClosed);
    timer = setInterval(check, 1500); // le token apparait parfois apres le chargement de l'app
    lw.loadURL('https://discord.com/login').catch((err) => {
      if (!done && !String(err).includes('ERR_ABORTED')) finish({ error: String((err && err.message) || err) }, true);
    });
  });
  return loginInFlight;
}

function writeSmoke(result) {
  if (!smokeOut) return;
  try { fs.writeFileSync(smokeOut, JSON.stringify(result)); } catch { /* ignore */ }
}

function shutdown() {
  if (server) { try { server.close(); } catch { /* ignore */ } server = null; }
}

async function start() {
  globalThis.__FORGET_SOCIAL_WINDOW = require('./social-windows.js').openSocialWindow;
  globalThis.__FORGET_TIKTOK = require('./tiktok-window.js');
  globalThis.__FORGET_OAUTH_WINDOW = require('./oauth-window.js').runOAuthWindow;
  // Mise a jour (Forget.exe portable uniquement) : le nouvel executable verifie (SHA-256) remplace le fichier
  // lance par l'utilisateur des que celui-ci est libere (fermeture de Forget), puis Forget est relance.
  // PORTABLE_EXECUTABLE_FILE est defini par le lanceur portable d'electron-builder (templates/nsis/portable.nsi).
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portableExe && /\.exe$/i.test(portableExe)) {
    globalThis.__FORGET_INSTALL_UPDATE = async (file) => {
      const dir = path.resolve(require('node:os').tmpdir(), 'forget-update');
      const full = path.resolve(file);
      const target = path.resolve(portableExe);
      const unsafe = (p) => /["%^&|<>\r\n]/.test(p); // chemins injectes dans un script cmd
      if (path.dirname(full) !== dir || !/\.exe$/i.test(full) || !fs.existsSync(full) || unsafe(full)) throw new Error('Fichier de mise a jour refuse');
      if (!fs.existsSync(target) || unsafe(target)) throw new Error('Emplacement de Forget.exe introuvable ou non pris en charge');
      const script = path.join(dir, `apply-update-${process.pid}.cmd`);
      fs.writeFileSync(script, [
        '@echo off', 'set /a n=0',
        ':retry', // l'executable reste verrouille jusqu'a la fermeture du lanceur portable
        `move /Y "${full}" "${target}" >nul 2>&1 && goto done`,
        'set /a n+=1', 'if %n% geq 120 goto relaunch', 'ping -n 2 127.0.0.1 >nul', 'goto retry',
        ':done', ':relaunch', `start "" "${target}"`, 'del "%~f0"', '',
      ].join('\r\n'));
      await new Promise((ok, ko) => {
        const child = require('node:child_process').spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', (e) => ko(new Error(`Impossible de preparer la mise a jour : ${e.message}`)));
        child.once('spawn', () => { child.unref(); ok(); });
      });
      setTimeout(() => { shutdown(); app.quit(); }, 500);
    };
  }
  // Hooks lus par le serveur : definis AVANT l'import du bundle.
  globalThis.__FORGET_LOGIN_WINDOW = () => openDiscordLogin();
  if (safeStorage.isEncryptionAvailable()) {
    globalThis.__FORGET_CIPHER = {
      encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
      decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
    };
  }
  const bundle = path.join(__dirname, 'build', 'server.mjs');
  const mod = await import(pathToFileURL(bundle).href);
  server = await mod.startServer({ webDist: path.join(__dirname, 'build', 'web') });
  const origin = `http://127.0.0.1:${server.port}`;
  const isLocal = (u) => u === origin || u.startsWith(origin + '/');
  ipcMain.handle('forget:pick-file', async (event, kind) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !isLocal(event.senderFrame.url)) throw new Error('Fenêtre non autorisée');
    if (!['export', 'engine-db', 'export-dir'].includes(kind)) throw new Error('Type de source invalide');
    const result = await dialog.showOpenDialog(win, {
      title: 'Choisir la source à importer',
      properties: [kind === 'export-dir' ? 'openDirectory' : 'openFile'],
      filters: kind === 'export-dir' ? [] : [{ name: kind === 'export' ? 'Export Discord' : 'Base Forget Engine', extensions: kind === 'export' ? ['zip'] : ['db', 'sqlite', 'sqlite3'] }],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    const ok = isLocal(u) || u.startsWith('data:') || u.startsWith('blob:') || (dev && u.startsWith('devtools://'));
    cb({ cancel: !ok });
  });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);

  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 700,
    backgroundColor: '#0b0d10', title: 'Forget',
    show: false, // affichee apres le chargement (le splash couvre l attente)
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      devTools: dev,
    },
  });
  win.on('page-title-updated', (e) => e.preventDefault()); // le titre de fenetre reste « Forget »
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!isLocal(url)) e.preventDefault(); });
  win.on('closed', () => { win = null; });

  const loaded = new Promise((resolve, reject) => {
    win.webContents.once('did-finish-load', resolve);
    win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`did-fail-load ${code} ${desc}`)));
  });
  win.loadURL(origin + '/');
  await loaded;
  // Hold de test : laisse le splash visible N ms (capture de verification uniquement).
  const holdMs = Number(process.env.FORGET_SPLASH_HOLD_MS || 0);
  if (holdMs > 0 && splashShownAt) {
    const wait = holdMs - (Date.now() - splashShownAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  closeSplash();
  if (!smoke) win.show();

  if (smoke) {
    const get = async (p) => (await fetch(origin + p)).status;
    const result = {
      ok: false, http: { health: await get('/api/health'), root: await get('/'), import: await get('/api/import/status') },
      fileBridge: await win.webContents.executeJavaScript("typeof window.forget?.pickFile === 'function'"),
      title: win.webContents.getTitle(), windowTitle: win.getTitle(), url: win.webContents.getURL(),
      port: server.port, dbPath: process.env.FORGET_DB_PATH, electron: process.versions.electron,
    };
    result.ok = result.http.health === 200 && result.http.root === 200 && result.http.import === 200 && result.fileBridge && isLocal(result.url);
    writeSmoke(result);
    shutdown();
    app.exit(result.ok ? 0 : 1);
  }
}

function buildMenu() {
  const view = [
    { role: 'reload', label: 'Recharger' }, { role: 'togglefullscreen', label: 'Plein ecran' },
    { type: 'separator' }, { role: 'resetZoom', label: 'Zoom normal' },
    { role: 'zoomIn', label: 'Zoom +' }, { role: 'zoomOut', label: 'Zoom -' },
  ];
  if (dev) view.push({ type: 'separator' }, { role: 'toggleDevTools', accelerator: 'Ctrl+Shift+I' });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Fichier', submenu: [{ role: 'quit', label: 'Quitter' }] },
    { label: 'Affichage', submenu: view },
  ]));
}

if (!smoke && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('before-quit', shutdown);
  app.on('window-all-closed', () => { if (!smoke) app.quit(); });
  app.on('web-contents-created', (_e, wc) => { wc.on('will-attach-webview', (e) => e.preventDefault()); });
  app.whenReady().then(() => { buildMenu(); if (!smoke) openSplash(); return start(); }).catch((err) => {
    if (smoke) writeSmoke({ ok: false, error: String((err && err.stack) || err) });
    else console.error(err);
    closeSplash();
    shutdown();
    app.exit(1);
  });
  if (smoke) {
    setTimeout(() => { writeSmoke({ ok: false, error: 'timeout 60s' }); shutdown(); app.exit(1); }, 60000).unref();
  }
}
