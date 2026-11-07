/**
 * A click must never pass through /auth because the session went stale while
 * the tab was in the background.
 *
 * The middleware (`middleware.ts`) never refreshes a session itself: a
 * server-side refresh rotates the single-use refresh token (KRTX-2111). A
 * request whose session cookie is expired or inside the refresh margin
 * (`cookieIdentityPlan`) bounces to `/auth?redirect=…`, and the browser client
 * refreshes there and replaces the route back.
 *
 * Nothing refreshes the cookie while a tab is hidden: auth-js stops its
 * refresh timer on `visibilitychange` and starts a recovery only when the tab
 * comes back, and a sleeping laptop runs no timer at all. The first click
 * after the return raced that recovery. When the click won, the navigation
 * went to `/auth` and back, and the whole app re-mounted, which looks
 * exactly like a reload. A hover prefetch in the same window is worse: the
 * App Router caches the redirected route under the link, and a later click
 * on that link still goes to `/auth`.
 *
 * So every same-origin App Router request (a navigation or prefetch carries
 * `RSC`, a Server Action carries `Next-Action`) first reads the same cookie
 * the middleware reads. When it is stale, the request waits for one browser
 * refresh, shared by every request that arrives meanwhile, and is sent after
 * it. The wait has a limit: a refresh that hangs or fails releases the
 * request, and the middleware decides as before. Every other request goes
 * out untouched.
 *
 * A bounce that still happens (the refresh failed, or the session is gone)
 * must not reach the router cache. The App Router caches a redirected RSC
 * response under the URL that was asked for, for `staleTimes.dynamic`
 * (300 s). `/auth` then sends a signed-in user back with `router.replace`, the
 * router serves the cached redirect, the tab stays on `/auth`, and after
 * 2.5 s `/auth` shows the sign-in form to a user who is signed in. So an RSC
 * response that the middleware redirected to `/auth?redirect=…` reaches the
 * router as a failed, non-Flight response at the `/auth` URL: a navigation
 * then loads `/auth` as a new document, with an empty router cache, and a
 * prefetch is dropped instead of cached.
 */
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { cookieIdentityPlan } from '@/lib/supabase/middleware-identity';
import { readUnverifiedSession } from '@/lib/supabase/session-cookie';

/** The longest a navigation waits for the refresh before it goes out anyway. */
export const NAVIGATION_REFRESH_WAIT_MS = 5_000;

/**
 * The middleware compares the cookie's `expires_at` with the SERVER clock. The
 * client refreshes this much earlier, so a client clock that runs behind the
 * server still refreshes before the middleware calls the cookie stale.
 */
export const CLIENT_CLOCK_SKEW_MS = 30_000;

const NAVIGATION_HEADERS = ['rsc', 'next-action'];

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
/** The call signature of `fetch`, without runtime extras such as Bun's `fetch.preconnect`. */
export type FetchFunction = (input: FetchInput, init?: FetchInit) => Promise<Response>;
type HeadersLike = NonNullable<RequestInit['headers']>;

export interface NavigationSessionGateDeps {
  /** The page origin. Requests to any other origin are never gated. */
  origin: string;
  /** `document.cookie`. */
  readCookie: () => string;
  now: () => number;
  /** Makes the session cookie fresh. Rejects or never settles on failure. */
  refresh: () => Promise<unknown>;
  /** Resolves after `ms`. Injected so a test controls time. */
  wait?: (ms: number) => Promise<unknown>;
}

function parseCookieHeader(header: string): Array<{ name: string; value: string }> {
  const cookies: Array<{ name: string; value: string }> = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const raw = part.slice(separator + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // A value that is not URI-encoded is used as written.
    }
    cookies.push({ name, value });
  }
  return cookies;
}

/** True when the middleware would bounce a request that carries this cookie. */
export function sessionCookieNeedsRefresh(cookieHeader: string, nowMs: number): boolean {
  const session = readUnverifiedSession(parseCookieHeader(cookieHeader), KORTIX_SUPABASE_AUTH_COOKIE);
  const expiresAt = typeof session?.expires_at === 'number' ? session.expires_at : null;
  return cookieIdentityPlan(expiresAt, nowMs + CLIENT_CLOCK_SKEW_MS) === 'stale';
}

function hasHeader(headers: HeadersLike | Headers | undefined, names: string[]): boolean {
  if (!headers) return false;
  if (typeof (headers as Headers).has === 'function') {
    return names.some((name) => (headers as Headers).has(name));
  }
  const keys = Array.isArray(headers)
    ? headers.map(([key]) => key)
    : Object.keys(headers as Record<string, string>);
  return keys.some((key) => names.includes(key.toLowerCase()));
}

function isRequest(input: FetchInput): input is Request {
  return typeof input === 'object' && input !== null && !(input instanceof URL) && 'url' in input;
}

function requestHeaders(input: FetchInput, init: FetchInit): HeadersLike | Headers | undefined {
  return init?.headers ?? (isRequest(input) ? input.headers : undefined);
}

function isSameOrigin(input: FetchInput, origin: string): boolean {
  try {
    const href = isRequest(input) ? input.url : String(input);
    return new URL(href, origin).origin === origin;
  } catch {
    return false;
  }
}

/** A same-origin App Router request: a navigation, a prefetch or a Server Action. */
export function isAppRouterRequest(input: FetchInput, init: FetchInit, origin: string): boolean {
  return hasHeader(requestHeaders(input, init), NAVIGATION_HEADERS) && isSameOrigin(input, origin);
}

/** The middleware's bounce: a protected route sent to `/auth` with the way back in `redirect`. */
function isSignInBounce(response: Response, origin: string): boolean {
  if (!response.redirected) return false;
  try {
    const url = new URL(response.url);
    return url.origin === origin && url.pathname === '/auth' && url.searchParams.has('redirect');
  } catch {
    return false;
  }
}

/** A failed, non-Flight response at the bounce URL: the router loads it as a document and never caches it. */
function signInDocument(bounced: Response): Response {
  void bounced.body?.cancel().catch(() => {});
  const response = new Response('', {
    status: 401,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
  Object.defineProperty(response, 'url', { value: bounced.url });
  return response;
}

const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `baseFetch`, except an App Router request with a stale session waits for one refresh first. */
export function gateNavigationFetch(
  baseFetch: FetchFunction,
  deps: NavigationSessionGateDeps,
): FetchFunction {
  const wait = deps.wait ?? realWait;
  let refreshing: Promise<void> | null = null;

  const awaitRefresh = (): Promise<unknown> => {
    if (!refreshing) {
      const run = Promise.resolve()
        .then(deps.refresh)
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          if (refreshing === run) refreshing = null;
        });
      refreshing = run;
    }
    return Promise.race([refreshing, wait(NAVIGATION_REFRESH_WAIT_MS)]);
  };

  const send = (input: FetchInput, init: FetchInit): Promise<Response> => {
    const response = baseFetch(input, init);
    // A Server Action decodes its own redirects; only RSC responses feed the router cache.
    if (!hasHeader(requestHeaders(input, init), ['rsc'])) return response;
    return response.then((res) => (isSignInBounce(res, deps.origin) ? signInDocument(res) : res));
  };

  return (input, init) => {
    if (!isAppRouterRequest(input, init, deps.origin)) return baseFetch(input, init);
    if (!sessionCookieNeedsRefresh(deps.readCookie(), deps.now())) return send(input, init);
    return awaitRefresh().then(() => send(input, init));
  };
}

/**
 * Refresh the browser session when it is inside the refresh margin.
 *
 * `getSession()` refreshes inside auth-js's own 90 s margin, which equals the
 * middleware's. It reads the shared cookie first, so a session another tab
 * already refreshed is not refreshed again. Only a session inside the extra
 * clock-skew margin needs the explicit `refreshSession()`.
 */
async function refreshBrowserSession(): Promise<void> {
  const { createClient } = await import('@/lib/supabase/client');
  const auth = createClient().auth;
  const { data } = await auth.getSession();
  const expiresAt = data.session?.expires_at;
  if (
    typeof expiresAt === 'number' &&
    cookieIdentityPlan(expiresAt, Date.now() + CLIENT_CLOCK_SKEW_MS) === 'stale'
  ) {
    await auth.refreshSession();
  }
}

const INSTALLED = Symbol.for('kortix.navigationSessionGate');

/** Wrap `window.fetch` once, before the App Router sends its first request. */
export function installNavigationSessionGate(): void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  const current = window.fetch as FetchFunction & { [INSTALLED]?: true };
  if (current[INSTALLED]) return;
  const gated: FetchFunction & { [INSTALLED]?: true } = gateNavigationFetch(current.bind(window), {
    origin: window.location.origin,
    readCookie: () => document.cookie,
    now: () => Date.now(),
    refresh: refreshBrowserSession,
  });
  gated[INSTALLED] = true;
  window.fetch = gated as typeof fetch;
}
