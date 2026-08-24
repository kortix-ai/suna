/**
 * Recover a browser navigation that escaped a path-based preview prefix.
 *
 * The path proxy serves an app at `/v1/p/{sandbox}/{port}/…`, but an app that
 * emits a ROOT-ABSOLUTE link (`<a href="/learn">`) hands the browser a URL that
 * resolves against the API ORIGIN, dropping the prefix entirely:
 *
 *   served at  https://dev-api.kortix.com/v1/p/sbx_01M0…/8081/
 *   click      <a href="/learn">
 *   browser go https://dev-api.kortix.com/learn        ← prefix gone → API 404
 *
 * `sanitizeRedirectLocation` already covers the server-redirect form of this
 * (`Location: /learn`); it cannot cover a link the browser resolved on its own,
 * because the API never saw the HTML.
 *
 * This is the last-resort catch: on an otherwise-404 request that is a TOP-LEVEL
 * DOCUMENT NAVIGATION whose Referer is a preview page on this same origin, send
 * the browser back into that page's prefix. It restores hyperlink navigation on
 * path-based previews. It is NOT a substitute for origin-per-preview
 * (`p{port}-{sandbox}.{previewDomain}`), which is what makes `fetch('/api')`,
 * `history.pushState('/learn')`, CSS `url(/x.png)`, service-worker scope, and
 * WebSockets work — none of which produce a navigation this hook can see.
 *
 * Gates, all required, so ordinary API 404s are never touched:
 *   - the request is a document navigation (Sec-Fetch-Dest: document, or a
 *     legacy `Accept: text/html` with no Sec-Fetch headers at all);
 *   - the Referer is same-origin AND its path is a preview prefix;
 *   - the request path is not already under `/v1/p/` (no loops).
 */

const PREVIEW_PREFIX = /^\/v1\/p\/([^/]+)\/(\d{1,5})(?:\/|$)/;

function isDocumentNavigation(headers: Headers): boolean {
  const dest = headers.get('sec-fetch-dest');
  if (dest) return dest === 'document';
  // No Sec-Fetch-* at all (old browsers, curl): fall back to the Accept header.
  if (headers.get('sec-fetch-mode') || headers.get('sec-fetch-site')) return false;
  return (headers.get('accept') || '').includes('text/html');
}

/**
 * The `/v1/p/{sandbox}/{port}` prefix of a preview page, or null when the
 * Referer is absent, cross-origin, or not a preview page.
 */
function refererPreviewPrefix(referer: string | null, requestUrl: URL): string | null {
  if (!referer) return null;
  let ref: URL;
  try {
    ref = new URL(referer);
  } catch {
    return null;
  }
  // Same-origin only: a preview page is served from this very origin, so a
  // cross-origin Referer is never a prefix escape — it is someone else linking
  // at us, and rewriting that would be an open redirect surface.
  if (ref.host !== requestUrl.host) return null;
  const match = PREVIEW_PREFIX.exec(ref.pathname);
  if (!match) return null;
  return `/v1/p/${match[1]}/${match[2]}`;
}

export interface PrefixEscapeRedirect {
  location: string;
  /** 307 for non-GET/HEAD so a form POST keeps its method and body. */
  status: 302 | 307;
}

export function resolvePrefixEscape(req: {
  method: string;
  url: string;
  headers: Headers;
}): PrefixEscapeRedirect | null {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return null;
  }
  // Already inside the proxy — the preview route matches every path under it,
  // so a 404 from there is the upstream's own answer, not an escape.
  if (url.pathname.startsWith('/v1/p/')) return null;
  if (!isDocumentNavigation(req.headers)) return null;

  const prefix = refererPreviewPrefix(req.headers.get('referer'), url);
  if (!prefix) return null;

  const method = req.method.toUpperCase();
  return {
    location: `${prefix}${url.pathname}${url.search}`,
    status: method === 'GET' || method === 'HEAD' ? 302 : 307,
  };
}
