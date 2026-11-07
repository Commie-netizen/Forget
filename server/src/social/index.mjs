import { Hono } from 'hono';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { insertArchive } from '../discord/store.mjs';
import { USER_AGENT } from '../version.mjs';

export const PLATFORMS = {
  // OAuth 2.0 (docs.x.com : PKCE, client public ; wiki OAuth2 de Reddit : application « installed », sans secret).
  twitter: { name: 'Twitter/X', mode: 'api', base: 'https://api.x.com', scopes: 'tweet.read tweet.write users.read',
    authorize: 'https://x.com/i/oauth2/authorize', token: 'https://api.x.com/2/oauth2/token', oauthScopes: 'tweet.read tweet.write users.read offline.access' },
  reddit: { name: 'Reddit', mode: 'api', base: 'https://oauth.reddit.com', scopes: 'identity history read edit',
    authorize: 'https://www.reddit.com/api/v1/authorize', token: 'https://www.reddit.com/api/v1/access_token', oauthScopes: 'identity history read edit' },
  facebook: { name: 'Facebook', mode: 'assisted', url: 'https://www.facebook.com/me/allactivity' },
  instagram: { name: 'Instagram', mode: 'assisted', url: 'https://www.instagram.com/your_activity/photos_and_videos/posts/' },
};
const initialized = new WeakSet();
export function initSocial(db) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS socialAccount(provider TEXT PRIMARY KEY,userId TEXT,username TEXT,secret TEXT);
    CREATE TABLE IF NOT EXISTS socialItem(provider TEXT,userId TEXT,id TEXT,data TEXT,PRIMARY KEY(provider,userId,id));
    CREATE TABLE IF NOT EXISTS socialJob(id TEXT PRIMARY KEY,provider TEXT,userId TEXT,status TEXT,total INTEGER,deleted INTEGER DEFAULT 0,failed INTEGER DEFAULT 0,createdAt INTEGER,error TEXT);
    UPDATE socialJob SET status='interrupted' WHERE status IN ('queued','running','paused');`);
  initialized.add(db);
}

export function socialRouter(db, { fetchImpl = (...args) => fetch(...args), now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  initSocial(db);
  const app = new Hono(), sessions = new Map(), queues = new Map(), deadlines = new Map(), tasks = new Map();
  const fail = (message, status = 400) => Object.assign(new Error(message), { status });
  const cfg = p => { if (!PLATFORMS[p]) throw fail('Plateforme inconnue', 404); return PLATFORMS[p]; };
  const cipher = () => globalThis.__FORGET_CIPHER;
  const busy = p => [...tasks.values()].some(t => t.provider === p);
  // Identifiants : jeton seul (saisie manuelle, stocké tel quel) ou JSON { access, refresh, expiresAt, clientId } (OAuth).
  const parseCred = raw => {
    if (typeof raw !== 'string' || !raw) return null;
    if (raw.startsWith('{')) { try { const j = JSON.parse(raw); if (typeof j.access === 'string' && j.access) return j; } catch { /* jeton brut */ } }
    return { access: raw };
  };
  const serializeCred = cred => (cred.refresh || cred.clientId ? JSON.stringify(cred) : cred.access);
  function account(p) {
    const row = db.prepare('SELECT * FROM socialAccount WHERE provider=?').get(p);
    if (!row) return null;
    let cred = sessions.get(p);
    if (!cred && row.secret && cipher()) { try { cred = parseCred(cipher().decrypt(row.secret)); } catch { /* reauthentication required */ } }
    return cred ? { ...row, token: cred.access, cred } : null;
  }
  function persist(p, userId, username, cred) {
    const secret = cipher() ? cipher().encrypt(serializeCred(cred)) : null;
    db.prepare('INSERT OR REPLACE INTO socialAccount VALUES (?,?,?,?)').run(p, String(userId), String(username), secret);
    sessions.set(p, cred);
  }
  // Échange / renouvellement de jeton : POST form-urlencoded vers l'endpoint officiel du fournisseur.
  async function tokenRequest(p, form, clientId) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT };
    if (p === 'reddit') headers.Authorization = 'Basic ' + Buffer.from(`${clientId}:`).toString('base64');
    let res;
    try { res = await fetchImpl(cfg(p).token, { method: 'POST', redirect: 'error', headers, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(30000) }); }
    catch { throw fail('Connexion refusée ou indisponible. Vérifiez le mode hors-ligne.', 502); }
    let data = {};
    try { data = JSON.parse(await res.text() || '{}'); } catch { /* réponse non JSON */ }
    if (!res.ok || typeof data.access_token !== 'string' || !data.access_token) {
      throw fail(`La plateforme a refusé l’autorisation${data.error ? ` (${String(data.error).slice(0, 80)})` : ` (HTTP ${res.status})`}.`, res.status === 400 || res.status === 401 ? 401 : 502);
    }
    return data;
  }
  const credFrom = (data, prev = {}) => ({ ...prev, access: data.access_token, refresh: data.refresh_token || prev.refresh || null,
    expiresAt: Number(data.expires_in) > 0 ? now() + Number(data.expires_in) * 1000 : null });
  // Renouvelle le jeton s'il expire dans moins d'une minute (refresh token OAuth uniquement).
  // Un seul renouvellement à la fois par plateforme : X fait tourner les refresh tokens (usage unique).
  const refreshing = new Map();
  async function fresh(p, a) {
    const c = a.cred;
    if (!c?.refresh || !c.clientId || !c.expiresAt || c.expiresAt - now() > 60000) return a;
    if (!refreshing.has(p)) {
      const run = (async () => {
        const form = p === 'twitter' ? { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId } : { grant_type: 'refresh_token', refresh_token: c.refresh };
        const cred = credFrom(await tokenRequest(p, form, c.clientId), c);
        // Compte déconnecté (ou remplacé) pendant l'échange : on ne réinsère rien.
        const row = db.prepare('SELECT userId FROM socialAccount WHERE provider=?').get(p);
        if (!row || row.userId !== String(a.userId)) throw fail('Compte déconnecté pendant le renouvellement du jeton.', 409);
        persist(p, a.userId, a.username, cred);
        return cred;
      })();
      refreshing.set(p, run);
      run.finally(() => refreshing.delete(p)).catch(() => {});
    }
    const cred = await refreshing.get(p);
    return { ...a, token: cred.access, cred };
  }
  // Identité vérifiée puis stockage chiffré (ou mémoire de session si le chiffrement est indisponible).
  async function establish(p, cred) {
    const user = await request(p, cred.access, 'GET', p === 'twitter' ? '/2/users/me' : '/api/v1/me');
    const id = p === 'twitter' ? user.data?.id : user.id, name = p === 'twitter' ? user.data?.username : user.name;
    if (!id || !name) throw fail('Impossible de vérifier l’identité du compte.', 502);
    persist(p, id, name, cred);
    return status(p);
  }
  async function waitControl(control) {
    while (control?.paused && !control.cancelled) await sleep(100);
    if (control?.cancelled) throw fail('Opération annulée', 499);
  }
  async function request(p, token, method, path, { body, control } = {}) {
    const previous = queues.get(p) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        await waitControl(control);
        while ((deadlines.get(p) || 0) > now()) {
          await sleep(Math.min(250, deadlines.get(p) - now())); await waitControl(control);
        }
        const url = new URL(path, cfg(p).base);
        if (url.origin !== cfg(p).base) throw fail('Destination interdite');
        let res;
        try {
          res = await fetchImpl(url.href, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
            headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
            body: body ? new URLSearchParams(body).toString() : undefined });
        } catch { throw fail('Connexion refusée ou indisponible. Vérifiez le mode hors-ligne.', 502); }
        const text = await res.text(); let data;
        try { data = text ? JSON.parse(text) : {}; } catch { if (res.status === 429) data = {}; else throw fail('Réponse inattendue de la plateforme', 502); }
        const num = h => { const v = res.headers.get(h); return v === null ? null : Number(v); };
        const remaining = num(p === 'twitter' ? 'x-rate-limit-remaining' : 'x-ratelimit-remaining');
        const reset = num(p === 'twitter' ? 'x-rate-limit-reset' : 'x-ratelimit-reset');
        let deadline = now() + 1000; // application pacing, not a claimed provider quota
        if (remaining !== null && remaining <= 0 && reset !== null && Number.isFinite(reset)) deadline = Math.max(deadline, p === 'twitter' ? reset * 1000 + 100 : now() + reset * 1000 + 100);
        if (res.status === 429) {
          const retry = res.headers.get('retry-after');
          const ms = retry && Number.isFinite(Number(retry)) ? Number(retry) * 1000 : retry ? Date.parse(retry) - now() : 60000;
          deadline = Math.max(deadline, now() + (Number.isFinite(ms) ? Math.max(0, ms) : 60000) + 100);
        }
        deadlines.set(p, deadline);
        if (res.status === 429) continue;
        if (!res.ok) throw fail(res.status === 401 ? 'Session expirée : reconnectez le compte.' : res.status === 403 ? 'Accès refusé : vérifiez les permissions et votre accès API.' : res.status === 402 ? 'La plateforme demande un accès API payant ou des crédits.' : `La plateforme a répondu HTTP ${res.status}.`, res.status);
        if (data?.json?.errors?.length) throw fail('La plateforme a refusé cette opération.', 422);
        return data;
      }
      throw fail('Limite API persistante : opération arrêtée après cinq tentatives.', 429);
    });
    queues.set(p, current); return current;
  }
  function normalize(p, raw) {
    if (p === 'twitter') return { id: raw.id, author: raw.author_id, text: raw.text || '', date: raw.created_at || null, url: `https://x.com/i/status/${raw.id}`, kind: 'publication' };
    return { id: raw.name, author: raw.author, text: [raw.title, raw.selftext || raw.body].filter(Boolean).join('\n'), date: raw.created_utc ? new Date(raw.created_utc * 1000).toISOString() : null,
      url: typeof raw.permalink === 'string' && raw.permalink.startsWith('/') ? 'https://www.reddit.com' + raw.permalink : '', kind: raw.name?.startsWith('t1_') ? 'commentaire' : 'publication' };
  }
  const owned = (p, item, a) => String(item.author || '').toLowerCase() === String(p === 'twitter' ? a.userId : a.username).toLowerCase();
  function cache(p, a, item) { db.prepare('INSERT OR REPLACE INTO socialItem VALUES (?,?,?,?)').run(p, a.userId, item.id, JSON.stringify(item)); }
  async function lookup(p, a, id, control) {
    const data = p === 'twitter'
      ? await request(p, a.token, 'GET', `/2/tweets/${id}?tweet.fields=author_id,created_at`, { control })
      : await request(p, a.token, 'GET', `/api/info?id=${encodeURIComponent(id)}&raw_json=1`, { control });
    const raw = p === 'twitter' ? data.data : data?.data?.children?.find(c => c.data?.name === id)?.data;
    if (!raw) throw fail('Publication introuvable ; aucune suppression effectuée.', 404);
    const item = normalize(p, raw);
    if (item.id !== id || !owned(p, item, a)) throw fail('La publication ne correspond pas au compte connecté.', 403);
    return item;
  }
  function status(p) {
    const c = cfg(p), a = c.mode === 'api' ? account(p) : null;
    return { provider: p, name: c.name, mode: c.mode, connected: !!a, user: a ? { id: a.userId, name: a.username } : null,
      persistence: a ? (a.secret ? 'encrypted' : 'session') : null, waitMs: Math.max(0, (deadlines.get(p) || 0) - now()), scopes: c.scopes || null,
      oauth: c.mode === 'api' ? { scopes: c.oauthScopes, renewable: !!a?.cred?.refresh, expiresAt: a?.cred?.expiresAt || null, clientId: a?.cred?.clientId || null } : null };
  }
  const required = async p => { const a = account(p); if (!a) throw fail('Connectez d’abord ce compte.', 409); return fresh(p, a); };
  app.onError((e,c) => c.json({ error: e.message }, [400,401,402,403,404,409,422,429,499,501,502].includes(e.status) ? e.status : 500));
  app.get('/', c => c.json(Object.keys(PLATFORMS).map(status)));
  app.get('/:provider/status', c => c.json(status(c.req.param('provider'))));
  app.post('/:provider/connect', async c => {
    const p = c.req.param('provider'); if (cfg(p).mode !== 'api') throw fail('Ce compte utilise le nettoyage assisté.');
    if (busy(p)) throw fail('Arrêtez l’opération avant de changer de compte.', 409);
    const b = await c.req.json(), token = typeof b.token === 'string' ? b.token.trim() : '';
    if (!token || token.length > 8192 || /[\r\n]/.test(token)) throw fail('Jeton OAuth utilisateur requis.');
    return c.json(await establish(p, { access: token }));
  });
  // Connexion OAuth : fenêtre officielle du fournisseur, redirection interceptée par Electron (rien n'écoute en local).
  app.post('/:provider/oauth', async c => {
    const p = c.req.param('provider'), conf = cfg(p); if (conf.mode !== 'api') throw fail('Ce compte utilise le nettoyage assisté.');
    if (busy(p)) throw fail('Arrêtez l’opération avant de changer de compte.', 409);
    const offline = db.prepare("SELECT value FROM setting WHERE key='privacy.offline'").get();
    if (!offline || offline.value !== 'false') throw fail('Désactivez le mode hors-ligne dans Réglages → Confidentialité.', 409);
    const hook = globalThis.__FORGET_OAUTH_WINDOW;
    if (typeof hook !== 'function') throw fail('Disponible dans l’application Electron uniquement.', 501);
    const b = await c.req.json().catch(() => ({}));
    const clientId = typeof b.clientId === 'string' ? b.clientId.trim() : '';
    const redirectUri = typeof b.redirectUri === 'string' ? b.redirectUri.trim() : '';
    if (!/^[A-Za-z0-9_.~-]{4,128}$/.test(clientId)) throw fail('Client ID de votre application requis.');
    let ru; try { ru = new URL(redirectUri); } catch { throw fail('URL de redirection invalide.'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(ru.hostname);
    if (redirectUri.length > 300 || !(ru.protocol === 'https:' || (ru.protocol === 'http:' && loopback)) || ru.hash) throw fail('URL de redirection : https, ou http sur 127.0.0.1 / localhost.');
    const state = randomBytes(16).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const auth = new URL(conf.authorize);
    const q = { response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: conf.oauthScopes, state };
    if (p === 'twitter') Object.assign(q, { code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    else q.duration = 'permanent';
    for (const [k, v] of Object.entries(q)) auth.searchParams.set(k, v);
    const r = await hook({ provider: p, authorizeUrl: auth.href, redirectUri });
    if (r?.cancelled) throw fail('Connexion annulée.', 400);
    let back; try { back = new URL(r?.url); } catch { throw fail('Réponse OAuth invalide.', 502); }
    if (back.searchParams.get('state') !== state) throw fail('Réponse OAuth invalide (state).', 400);
    if (back.searchParams.get('error')) throw fail(`Autorisation refusée : ${back.searchParams.get('error').slice(0, 80)}.`, 403);
    const code = back.searchParams.get('code'); if (!code) throw fail('Code d’autorisation absent.', 502);
    const form = { grant_type: 'authorization_code', code, redirect_uri: redirectUri, ...(p === 'twitter' ? { client_id: clientId, code_verifier: verifier } : {}) };
    const cred = credFrom(await tokenRequest(p, form, clientId), { clientId, redirectUri });
    return c.json(await establish(p, cred));
  });
  app.delete('/:provider/connect', c => {
    const p = c.req.param('provider'); cfg(p);
    if (busy(p)) throw fail('Arrêtez l’opération avant de déconnecter le compte.', 409);
    sessions.delete(p); db.prepare('DELETE FROM socialAccount WHERE provider=?').run(p); return c.json({ ok: true });
  });
  app.get('/:provider/posts', async c => {
    const p = c.req.param('provider'); cfg(p); const a = await required(p);
    const after = c.req.query('after') || ''; if (after.length > 1024) throw fail('Curseur invalide');
    const path = p === 'twitter' ? `/2/users/${encodeURIComponent(a.userId)}/tweets?max_results=100&tweet.fields=author_id,created_at${after ? '&pagination_token=' + encodeURIComponent(after) : ''}`
      : `/user/${encodeURIComponent(a.username)}/overview?limit=100&raw_json=1${after ? '&after=' + encodeURIComponent(after) : ''}`;
    const data = await request(p, a.token, 'GET', path);
    const raws = p === 'twitter' ? (data.data || []) : (data.data?.children || []).map(c => c.data);
    const items = raws.map(raw => normalize(p,raw)).filter(item => item.id && owned(p,item,a));
    for (const item of items) cache(p,a,item);
    return c.json({ items, next: p === 'twitter' ? data.meta?.next_token || null : data.data?.after || null });
  });
  app.post('/:provider/window', async c => {
    const p = c.req.param('provider'); if (cfg(p).mode !== 'assisted') throw fail('Utilisez la connexion OAuth.');
    const offline = db.prepare("SELECT value FROM setting WHERE key='privacy.offline'").get();
    if (!offline || offline.value !== 'false') throw fail('Désactivez le mode hors-ligne dans Réglages → Confidentialité.', 409);
    if (!globalThis.__FORGET_SOCIAL_WINDOW) throw fail('Disponible dans l’application Electron uniquement.', 501);
    await globalThis.__FORGET_SOCIAL_WINDOW(p); return c.json({ opened: true, authenticated: false });
  });
  app.get('/:provider/jobs', c => { const p = c.req.param('provider'); cfg(p); return c.json(db.prepare('SELECT * FROM socialJob WHERE provider=? ORDER BY createdAt DESC LIMIT 20').all(p)); });
  app.post('/:provider/jobs', async c => {
    const p = c.req.param('provider'); cfg(p); let a = await required(p); const b = await c.req.json();
    if (busy(p)) throw fail('Une opération est déjà en cours pour ce compte.',409);
    const ids = [...new Set(Array.isArray(b.ids) ? b.ids : [])];
    const valid = p === 'twitter' ? /^\d{1,22}$/ : /^t[13]_[a-z0-9]+$/;
    if (b.confirm !== true || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string' || !valid.test(id))) throw fail('Confirmez une sélection de 1 à 500 publications.');
    if (ids.some(id => !db.prepare('SELECT id FROM socialItem WHERE provider=? AND userId=? AND id=?').get(p,a.userId,id))) throw fail('Rechargez et vérifiez les publications avant de les sélectionner.');
    const id = randomUUID(), control = { provider:p, cancelled:false, paused:false };
    db.prepare("INSERT INTO socialJob(id,provider,userId,status,total,createdAt) VALUES (?,?,?,'queued',?,?)").run(id,p,a.userId,ids.length);
    tasks.set(id,control);
    void (async () => {
      await sleep(0);
      try {
        if (!control.paused) db.prepare("UPDATE socialJob SET status='running' WHERE id=?").run(id);
        for (const mid of ids) {
          await waitControl(control);
          a = await fresh(p, a);
          const item = await lookup(p,a,mid,control);
          insertArchive({ platform:p, kind:item.kind, messageId:mid, authorId:item.author, content:item.text,
            messageCreatedAt: item.date ? Date.parse(item.date) : null, action:'delete', meta:{ url:item.url, archiveScope:'text-and-metadata' } });
          const result = p === 'twitter' ? await request(p,a.token,'DELETE',`/2/tweets/${mid}`,{control})
            : await request(p,a.token,'POST','/api/del',{body:{id:mid},control});
          if (p === 'twitter' && result.data?.deleted !== true) throw fail('Suppression non confirmée par X.',502);
          db.prepare('UPDATE socialJob SET deleted=deleted+1 WHERE id=?').run(id);
          db.prepare('DELETE FROM socialItem WHERE provider=? AND userId=? AND id=?').run(p,a.userId,mid);
        }
        db.prepare("UPDATE socialJob SET status='done' WHERE id=?").run(id);
      } catch(e) {
        db.prepare('UPDATE socialJob SET status=?,failed=failed+?,error=? WHERE id=?').run(control.cancelled?'cancelled':'failed',control.cancelled?0:1,control.cancelled?null:e.message,id);
      } finally { tasks.delete(id); }
    })();
    return c.json({ jobId:id });
  });
  app.post('/:provider/jobs/:id/:action', c => {
    const p = c.req.param('provider'), id = c.req.param('id'), action = c.req.param('action');
    if (!['pause','resume','cancel'].includes(action)) throw fail('Action inconnue');
    const t=tasks.get(id); if(!t || t.provider!==p) throw fail('Opération active introuvable',404);
    if(action==='cancel') t.cancelled=true; else t.paused=action==='pause';
    if(action!=='cancel') db.prepare('UPDATE socialJob SET status=? WHERE id=?').run(t.paused?'paused':'running',id);
    return c.json({ok:true});
  });
  return app;
}
