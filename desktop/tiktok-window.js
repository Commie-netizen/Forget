'use strict';
// TikTok offers no official repost API. Forget therefore opens tiktok.com in an
// isolated window where the user logs in directly, then makes the site's own web requests
// INSIDE that page using the user's session (list: /api/repost/item_list/, removal: /tiktok/v1/upvote/delete).
// Forget calculates no signatures and reads no passwords or cookies. These undocumented endpoints
// may change without notice (verified on 2026-11-07).
const { BrowserWindow } = require('electron');
const { isOnline } = require('./social-windows.js');

const PAGE_DOMAINS = ['tiktok.com'];
const RESOURCE_DOMAINS = ['tiktok.com', 'tiktokv.com', 'tiktokv.eu', 'tiktokv.us', 'tiktokw.eu', 'tiktokw.us', 'tiktokcdn.com',
  'tiktokcdn-eu.com', 'tiktokcdn-us.com', 'ttwstatic.com', 'ibyteimg.com', 'ibytedtos.com', 'byteoversea.com'];
const inDomains = (url, domains) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && domains.some((d) => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch { return false; }
};

let win = null;

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 1100, height: 820, title: 'Forget - TikTok (your session)', autoHideMenuBar: true,
    webPreferences: { partition: 'persist:forget-tiktok', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false },
  });
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !isOnline() || !(inDomains(d.url, RESOURCE_DOMAINS) || d.url.startsWith('data:') || d.url.startsWith('blob:')) }));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (e, url) => { if (!inDomains(url, PAGE_DOMAINS)) e.preventDefault(); };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.on('closed', () => { win = null; });
  return win;
}

exports.open = async function open() {
  if (!isOnline()) throw new Error('Offline mode is on');
  const w = ensureWindow();
  w.show(); w.focus();
  const url = w.webContents.getURL();
  if (!inDomains(url, PAGE_DOMAINS)) await w.loadURL('https://www.tiktok.com/profile').catch(() => { /*login redirect */ });
  return { opened: true };
};

exports.isOpen = () => !!(win && !win.isDestroyed());
exports.close = () => { if (win && !win.isDestroyed()) win.close(); };

function run(code) {
  if (!win || win.isDestroyed()) throw Object.assign(new Error('Open the TikTok window and log in.'), { code: 'NO_WINDOW' });
  if (!isOnline()) throw Object.assign(new Error('Offline mode is on'), { code: 'OFFLINE' });
  if (!inDomains(win.webContents.getURL(), PAGE_DOMAINS)) throw Object.assign(new Error('The TikTok window left tiktok.com.'), { code: 'NO_WINDOW' });
  return win.webContents.executeJavaScript(code, true);
}

// Page context (site rehydration data): connected account and CSRF token.
const CONTEXT_JS = `(() => {
  try {
    let data = window.__$UNIVERSAL_DATA$__;
    if (!data || !data.__DEFAULT_SCOPE__) {
      const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      data = el && el.textContent ? JSON.parse(el.textContent) : null;
    }
    const ctx = data && data.__DEFAULT_SCOPE__ && data.__DEFAULT_SCOPE__['webapp.app-context'];
    const u = ctx && ctx.user;
    return { loggedIn: !!(u && u.secUid), secUid: (u && u.secUid) || null, uniqueId: (u && (u.uniqueId || u.unique_id)) || null,
      nickname: (u && (u.nickName || u.nickname)) || null, csrf: !!(ctx && ctx.csrfToken) };
  } catch (e) { return { loggedIn: false, error: String(e && e.message) }; }
})()`;

exports.context = async function context() {
  const c = await run(CONTEXT_JS);
  return { loggedIn: !!c?.loggedIn, secUid: c?.secUid || null, uniqueId: c?.uniqueId || null, nickname: c?.nickname || null };
};

exports.listReposts = async function listReposts({ secUid, cursor = '0', count = 30 }) {
  if (typeof secUid !== 'string' || !/^[A-Za-z0-9_.-]{10,200}$/.test(secUid)) throw new Error('TikTok account not identified');
  const c = String(cursor);
  if (!/^\d{1,25}$/.test(c)) throw new Error('Invalid cursor');
  const n = Math.min(30, Math.max(1, Number(count) || 30));
  return run(`(async () => {
    const p = new URLSearchParams({ aid: '1988', count: '${n}', coverFormat: '2', cursor: ${JSON.stringify(c)}, needPinnedItemIds: 'true', post_item_list_request_type: '0', secUid: ${JSON.stringify(secUid)} });
    const r = await fetch('https://www.tiktok.com/api/repost/item_list/?' + p.toString(), { method: 'GET', headers: { accept: '*/*' }, credentials: 'same-origin' });
    const raw = await r.text();
    let j = null; try { j = JSON.parse(raw); } catch (e) { /*non-JSON */ }
    if (!r.ok || !j) return { ok: false, httpStatus: r.status, statusCode: j ? j.status_code : null };
    if (j.status_code !== 0) return { ok: false, httpStatus: r.status, statusCode: j.status_code, message: j.status_msg || '' };
    return { ok: true, hasMore: !!j.hasMore, cursor: j.cursor != null ? String(j.cursor) : null,
      items: (j.itemList || []).map((e) => ({ id: String(e.id), desc: String(e.desc || '').slice(0, 2000),
        author: (e.author && e.author.uniqueId) || '', createTime: Number(e.createTime) || null })) };
  })()`);
};

exports.removeRepost = async function removeRepost(itemId) {
  const id = String(itemId);
  if (!/^\d{1,25}$/.test(id)) throw new Error('Invalid video ID');
  return run(`(async () => {
    let csrf = '';
    try {
      let data = window.__$UNIVERSAL_DATA$__;
      if (!data || !data.__DEFAULT_SCOPE__) { const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__'); data = el && el.textContent ? JSON.parse(el.textContent) : null; }
      const ctx = data && data.__DEFAULT_SCOPE__ && data.__DEFAULT_SCOPE__['webapp.app-context'];
      csrf = (ctx && ctx.csrfToken) || '';
    } catch (e) { /* no CSRF token */ }
    const headers = { accept: '*/*', 'content-type': 'application/x-www-form-urlencoded' };
    if (csrf) headers['tt-csrf-token'] = csrf;
    const p = new URLSearchParams({ aid: '1988', item_id: ${JSON.stringify(id)} });
    const r = await fetch('https://www.tiktok.com/tiktok/v1/upvote/delete?' + p.toString(), { method: 'POST', headers, credentials: 'same-origin', body: '' });
    const raw = await r.text();
    if (!r.ok) return { ok: false, httpStatus: r.status };
    if (!raw.trim()) return { ok: true, httpStatus: r.status };
    let j = null; try { j = JSON.parse(raw); } catch (e) { return { ok: false, httpStatus: r.status, message: 'Non-JSON response' }; }
    return j.status_code === 0 ? { ok: true, httpStatus: r.status } : { ok: false, httpStatus: r.status, statusCode: j.status_code, message: j.status_msg || '' };
  })()`);
};
