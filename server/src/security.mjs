// Protect the local server (127.0.0.1) from web pages open in the user's browser.
// - DNS rebinding: the Host header must specify a loopback address (127.0.0.1, localhost, [::1]).
// - CSRF: any request with an Origin must match the Host origin; Sec-Fetch-Site must be
// same-origin or none; writes require the X-Forget-Request header (a third-party site cannot add it
// without a CORS preflight, and the server sends no CORS headers).
// - Security headers on all responses (strict CSP for the UI).
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

/** Return a rejection reason, or null if the request is acceptable. Exported for tests. */
export function rejectReason({ method, host, origin, secFetchSite, marker }) {
  if (!LOOPBACK.has(hostnameOf(host))) return 'host not allowed';
  if (origin && origin !== 'null') {
    let o;
    try { o = new URL(origin); } catch { return 'invalid origin'; }
    if (o.host.toLowerCase() !== String(host).trim().toLowerCase() || !['http:', 'https:'].includes(o.protocol)) return 'origin not allowed';
  } else if (origin === 'null') return 'opaque origin refused';
  if (secFetchSite && !['same-origin', 'none'].includes(secFetchSite)) return 'cross-site request refused';
  if (!SAFE_METHODS.has(method) && marker !== '1') return 'missing X-Forget-Request header';
  return null;
}

/** Hono middleware: network guard and security headers. */
export function securityMiddleware() {
  return async (c, next) => {
    const reason = rejectReason({
      // Without a Host header (internal calls / tests), use the URL host; the Node server constructs it from Host.
      method: c.req.method, host: c.req.header('host') || new URL(c.req.url).host, origin: c.req.header('origin'),
      secFetchSite: c.req.header('sec-fetch-site'), marker: c.req.header(REQUEST_HEADER),
    });
    if (reason) return c.json({ error: `Request refused: ${reason}` }, 403);
    if (c.req.method === 'OPTIONS') return c.body(null, 204); // no CORS preflight is allowed
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
