const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

function normalizeForwardedHeader(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first || null;
}

/**
 * True when `req.url` is a path-only string (no scheme), which Bun.serve
 * produces for requests that arrive WITHOUT a `Host` header — notably raw
 * HTTP/1.0 port-scanner probes (`GET / HTTP/1.0\r\n\r\n`,
 * `GET /nice%20ports%2C/Tri%6Eity.txt%2ebak HTTP/1.0\r\n\r\n`). When this is
 * true, every downstream `new URL(c.req.url)` / `new URL(req.url)` call site
 * (and there are many — auth middleware, OpenAPI server URL, proxy handlers,
 * sandbox preview/public-share routes, git proxy, Slack/Teams webhook
 * routers) throws `TypeError: "/" cannot be parsed as a URL.` because the
 * WHATWG URL constructor requires a base when given a relative URL. That throw
 * bubbles to `app.onError` → `captureException` → Sentry → Better Stack as
 * scanner noise with 0 affected users
 * (BS pattern 28e9a65c…, first seen 2026-04-27). Rebuilding the Request with
 * the absolute URL before it reaches Hono makes all those call sites safe.
 */
export function isRelativeRequestUrl(req: Request): boolean {
  return !ABSOLUTE_URL_PATTERN.test(req.url);
}

export function getRequestUrl(req: Request, fallbackPort?: number): URL {
  if (ABSOLUTE_URL_PATTERN.test(req.url)) {
    return new URL(req.url);
  }

  const protocol = normalizeForwardedHeader(req.headers.get('x-forwarded-proto')) || 'http';
  const host = normalizeForwardedHeader(req.headers.get('x-forwarded-host'))
    || req.headers.get('host')
    || `localhost:${fallbackPort ?? 80}`;

  const pathname = req.url.startsWith('/') ? req.url : `/${req.url}`;
  return new URL(pathname, `${protocol}://${host}`);
}

/**
 * Returns `req` unchanged when its URL is already absolute, or a new Request
 * built on the absolute URL (preserving method, headers, body, cache mode,
 * signal) when Bun.serve handed us a path-only `req.url` (no `Host` header —
 * raw scanner probes). Downstream `new URL(c.req.url)` / `new URL(req.url)`
 * call sites assume an absolute URL and throw otherwise; rebuilding once at
 * the Bun.serve boundary is the single focused mitigation that covers all of
 * them without touching each call site. See {@link isRelativeRequestUrl}.
 */
export function ensureAbsoluteRequestUrl(req: Request, fallbackPort?: number): Request {
  if (!isRelativeRequestUrl(req)) return req;
  return new Request(getRequestUrl(req, fallbackPort), req);
}
