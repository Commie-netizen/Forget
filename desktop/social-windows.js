'use strict';
const { BrowserWindow } = require('electron');
const { DatabaseSync } = require('node:sqlite');
const windows = new Map();
const urls = { facebook:'https://www.facebook.com/me/allactivity', instagram:'https://www.instagram.com/your_activity/photos_and_videos/posts/' };
// Reread offline state at most every 500 ms (onBeforeRequest is called for every page resource).
let onlineCache = { at: 0, value: false };
function online() {
  const now = Date.now();
  if (now - onlineCache.at < 500) return onlineCache.value;
  let db, value = false;
  try { db = new DatabaseSync(process.env.FORGET_DB_PATH, { readOnly:true }); value = db.prepare("SELECT value FROM setting WHERE key='privacy.offline'").get()?.value === 'false'; }
  catch { value = false; } finally { db?.close(); }
  onlineCache = { at: now, value };
  return value;
}
exports.isOnline = online;
function allowed(url, resources = false) {
  try {
    const u = new URL(url);
    const domains = ['facebook.com','instagram.com',...(resources?['fbcdn.net','cdninstagram.com','fbsbx.com','facebook.net']:[])];
    return u.protocol==='https:' && domains.some(d=>u.hostname===d || u.hostname.endsWith('.'+d));
  } catch { return false; }
}
exports.openSocialWindow = async function(provider) {
  if (!urls[provider] || !online()) throw new Error('Invalid platform or offline mode is on');
  const existing=windows.get(provider); if(existing && !existing.isDestroyed()){existing.show();existing.focus();return;}
  const win=new BrowserWindow({width:1180,height:840,title:`Forget — ${provider} · assisted cleanup`,autoHideMenuBar:true,
    webPreferences:{partition:`persist:forget-personal-${provider}`,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,devTools:false}});
  windows.set(provider,win);
  win.on('closed',()=>windows.delete(provider));
  const ses=win.webContents.session;
  ses.setPermissionRequestHandler((_w,_p,cb)=>cb(false));ses.setPermissionCheckHandler(()=>false);
  ses.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!online() || !(allowed(details.url,true) || details.url.startsWith('data:') || details.url.startsWith('blob:'))}));
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  const navigate=(e,url)=>{if(!allowed(url))e.preventDefault();};
  win.webContents.on('will-navigate',navigate);win.webContents.on('will-redirect',navigate);
  try {await win.loadURL(urls[provider]);} catch {win.close();throw new Error('Could not open the platform. Check your connection.');}
};
