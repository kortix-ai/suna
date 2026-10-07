/**
 * CSRF gate for the path-form preview cookie.
 *
 * `__preview_session` is an ambient credential on the API origin: the browser
 * attaches it to any request to `/v1/p/`. A page on a same-SITE sibling host
 * (a preview or App origin) can send a "simple" cross-origin POST that carries
 * it, and `SameSite=Lax` does not stop a same-site request. The origin form has
 * the same gate (`isSameSiteRequest` in `preview-origin.ts`).
 *
 * A write whose ONLY credential is the cookie must come from this origin.
 * `Sec-Fetch-Site` is the browser's own answer: `same-origin` and `none` pass.
 * Where it is absent, `Origin` must match the request host; a request with no
 * Origin (curl, the CLI) passes, and it has no ambient cookie to abuse anyway.
 * A request that carries an explicit credential header is not ambient: it passes.
 *
 * A LEAF: it imports nothing.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const COOKIE = /(?:^|;\s*)__preview_session=/;

export function isCookieCsrfRefused(req: { method: string; headers: Headers }): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return false;
  const h = req.headers;
  if (!COOKIE.test(h.get('cookie') ?? '')) return false;
  if (h.get('authorization') || h.get('x-kortix-token')) return false;

  const site = h.get('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';

  const origin = h.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== h.get('host');
  } catch {
    return true;
  }
}
