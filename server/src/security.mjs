// Protection du serveur local (127.0.0.1) contre les pages web ouvertes dans le navigateur de l'utilisateur.
// - DNS rebinding : l'en-tête Host doit désigner une adresse de bouclage (127.0.0.1, localhost, [::1]).
// - CSRF : toute requête portant un Origin doit venir de la même origine que Host ; Sec-Fetch-Site doit être
//   same-origin ou none ; les écritures exigent l'en-tête X-Forget-Request (un site tiers ne peut pas l'ajouter
//   sans pré-vérification CORS, et le serveur n'émet aucun en-tête CORS).
// - En-têtes de sécurité sur toutes les réponses (CSP stricte pour l'interface).
export const REQUEST_HEADER = 'x-forget-request';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  "font-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

function hostnameOf(host) {
  if (!host) return '';
  const h = String(host).trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1); // [::1]:port
  return h.split(':')[0];
}

/** Renvoie un motif de refus, ou null si la requête est acceptable. Exporté pour les tests. */
export function rejectReason({ method, host, origin, secFetchSite, marker }) {
  if (!LOOPBACK.has(hostnameOf(host))) return 'hôte non autorisé';
  if (origin && origin !== 'null') {
    let o;
    try { o = new URL(origin); } catch { return 'origine invalide'; }
    if (o.host.toLowerCase() !== String(host).trim().toLowerCase() || !['http:', 'https:'].includes(o.protocol)) return 'origine non autorisée';
  } else if (origin === 'null') return 'origine opaque refusée';
  if (secFetchSite && !['same-origin', 'none'].includes(secFetchSite)) return 'requête inter-sites refusée';
  if (!SAFE_METHODS.has(method) && marker !== '1') return 'en-tête X-Forget-Request manquant';
  return null;
}

/** Middleware Hono : garde réseau + en-têtes de sécurité. */
export function securityMiddleware() {
  return async (c, next) => {
    const reason = rejectReason({
      // Sans en-tête Host (appel interne / tests), l'hôte de l'URL fait foi ; le serveur Node la construit depuis Host.
      method: c.req.method, host: c.req.header('host') || new URL(c.req.url).host, origin: c.req.header('origin'),
      secFetchSite: c.req.header('sec-fetch-site'), marker: c.req.header(REQUEST_HEADER),
    });
    if (reason) return c.json({ error: `Requête refusée : ${reason}` }, 403);
    if (c.req.method === 'OPTIONS') return c.body(null, 204); // aucune pré-vérification CORS n'est accordée
    await next();
    const h = c.res.headers;
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'no-referrer');
    h.set('X-Frame-Options', 'DENY');
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Content-Security-Policy', CSP);
    if (c.req.path.startsWith('/api/')) h.set('Cache-Control', 'no-store');
  };
}
