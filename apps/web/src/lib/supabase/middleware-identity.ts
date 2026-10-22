/**
 * Identity resolution for the middleware auth gate.
 *
 * The gate used to call `getUser()` on every non-auth route. `getUser()`
 * validates the access token by round-tripping GoTrue, so every client-side
 * navigation paid one edge → Supabase hop before its RSC payload could even
 * start. That cost is invisible in a page-load benchmark and very visible when
 * clicking between sessions.
 *
 * Our projects sign with ES256, so `getClaims()` verifies the signature
 * in-process against a JWKS that auth-js caches globally — no network on the
 * common path. This is not a weaker check than `getUser()`: the cookie is
 * still never trusted unverified, the signature is checked with WebCrypto.
 *
 * `getUser()` remains the fallback for everything `getClaims()` cannot settle
 * locally — an expired token that needs a refresh, symmetric (HS*) signing
 * keys, WebCrypto unavailable — because it is also what produces the precise
 * error codes the caller's stale-session self-heal matches on.
 *
 * A valid signature does not prove the session is still live: a signed-out
 * session's token verifies until its `exp` (KRTX-2387: a re-presented cookie
 * rendered protected pages for up to 1 h after sign-out). So the first request
 * of a session asks GoTrue, and only a live answer lets the session take the
 * local path, for {@link SESSION_LIVENESS_TTL_MS} and never past `exp`. GoTrue
 * failing (network, 5xx) is no verdict: the verified identity stands, uncached.
 *
 * The caller guards the entry point with {@link cookieIdentityPlan}: a cookie
 * whose token is expired or inside the refresh margin never reaches this
 * resolver at all, because every auth-js read on such a cookie rotates the
 * single-use refresh token server-side (KRTX-2111). Only fresh cookies get
 * here, so the `getUser()` fallback below never has a refresh to fire.
 */

/** How long a GoTrue "this session is live" answer is trusted. */
export const SESSION_LIVENESS_TTL_MS = 30_000;

/**
 * How close to its expiry an access token may be before the middleware stops
 * trusting it and leaves the session to the browser.
 *
 * Mirrors auth-js's own refresh margin (three 30 s auto-refresh ticks = 90 s):
 * inside it auth-js treats the session as due for rotation. A rotation HERE
 * rotates the single-use refresh token on a response surface whose Set-Cookie
 * may not reach the browser (KRTX-2111), so the middleware declines instead:
 * `cookieIdentityPlan` returns `stale`, the request bounces to /auth, and the
 * browser client — the one writer that always sees its own rotation — repairs
 * the session there.
 */
export const SESSION_REFRESH_MARGIN_MS = 90_000;

export interface MiddlewareUser {
  id: string;
  user_metadata?: { locale?: string };
}

export interface MiddlewareIdentity {
  user: MiddlewareUser | null;
  authError: Error | null;
  /** Which path settled the identity. Kept for tests and tracing. */
  source: 'claims' | 'no-session' | 'get-user';
}

/**
 * The slice of `supabase.auth` this resolver needs. Declared structurally so
 * the tests can drive it without standing up a Supabase client.
 */
export interface MiddlewareAuth {
  getClaims: () => Promise<{
    data: { claims?: Record<string, unknown> | null } | null;
    error: unknown;
  }>;
  getUser: () => Promise<{
    data: { user: MiddlewareUser | null };
    error: unknown;
  }>;
}

const MAX_LIVE_SESSIONS = 10_000;
// replica-local: session id → when its live confirmation expires (ms).
// ponytail: per replica, so a sign-out is seen within the TTL, not at once; a shared store if that window must close.
const liveSessions = new Map<string, number>();

function rememberLive(sessionId: string, expSeconds: unknown) {
  const until = Math.min(Date.now() + SESSION_LIVENESS_TTL_MS, typeof expSeconds === 'number' ? expSeconds * 1000 : Infinity);
  if (liveSessions.size >= MAX_LIVE_SESSIONS) liveSessions.delete(liveSessions.keys().next().value!);
  liveSessions.set(sessionId, until);
}

/** A 4xx is GoTrue's verdict on the token; anything else (network, 5xx) says nothing about it. */
function isVerdict(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * Whether an auth error is GoTrue's verdict that the SESSION is dead and the
 * auth cookie may be destroyed.
 *
 * Only the refresh token's and the session row's own verdicts qualify. An
 * "Invalid JWT" 401 does NOT: it is also exactly what GoTrue answers for an
 * access token that merely EXPIRED while the refresh token is still alive —
 * deleting the cookie there throws away the one credential that could have
 * restored the session (KRTX-2111: the reported hard sign-out after a fresh
 * magic-link sign-in). A session the middleware cannot verify is bounced to
 * /auth, where the browser client either refreshes it or, if it really is
 * dead, signs out cleanly.
 */
export function isDeadSessionAuthError(error: unknown): boolean {
  if (!error) return false;
  const code = (error as { code?: string }).code;
  if (
    code === 'session_not_found' ||
    code === 'refresh_token_already_used' ||
    code === 'refresh_token_not_found'
  ) {
    return true;
  }
  // Older GoTrue builds name the refresh token only in the message.
  return /refresh token/i.test((error as { message?: string }).message ?? '');
}

/**
 * What the middleware may do with a request whose session cookie carries the
 * given `expires_at` (unix seconds, or null when there is no readable
 * session).
 *
 * `fresh` — the access token has life beyond the refresh margin: run the
 * verified identity resolver (its auth-js reads cannot rotate, because
 * auth-js only refreshes expired-or-in-margin sessions).
 *
 * `stale` — the token is expired or inside the margin: do NOT create the auth
 * client at all. Any auth-js read could rotate the single-use refresh token
 * server-side and lose the rotated cookie (KRTX-2111). Resolve as no identity
 * and bounce; the browser client repairs the session on /auth.
 *
 * `absent` — no readable session cookie: same bounce, without the client.
 */
export function cookieIdentityPlan(
  expiresAtSeconds: number | null | undefined,
  nowMs: number,
): 'fresh' | 'stale' | 'absent' {
  if (typeof expiresAtSeconds !== 'number') return 'absent';
  return expiresAtSeconds * 1000 - nowMs < SESSION_REFRESH_MARGIN_MS ? 'stale' : 'fresh';
}

function asError(value: unknown): Error | null {
  if (value === null || value === undefined) return null;
  return value instanceof Error ? value : (value as Error);
}

export async function resolveMiddlewareIdentity(auth: MiddlewareAuth): Promise<MiddlewareIdentity> {
  try {
    const { data, error } = await auth.getClaims();

    if (!error) {
      const sub = data?.claims?.sub;
      if (typeof sub === 'string' && sub.length > 0) {
        const metadata = data?.claims?.user_metadata as MiddlewareUser['user_metadata'];
        const verified: MiddlewareIdentity = {
          user: metadata ? { id: sub, user_metadata: metadata } : { id: sub },
          authError: null,
          source: 'claims',
        };
        const sessionId = data?.claims?.session_id;
        // Signature verified locally, and GoTrue confirmed the session within the TTL.
        if (typeof sessionId === 'string' && (liveSessions.get(sessionId) ?? 0) > Date.now()) return verified;
        try {
          const live = await auth.getUser();
          if (live.data.user && !live.error) {
            if (typeof sessionId === 'string') rememberLive(sessionId, data?.claims?.exp);
            return { user: live.data.user, authError: null, source: 'get-user' };
          }
          if (!live.error || isVerdict(live.error)) {
            return { user: null, authError: asError(live.error), source: 'get-user' };
          }
        } catch (error) {
          if (isVerdict(error)) return { user: null, authError: asError(error), source: 'get-user' };
        }
        return verified;
      }

      // No claims and no error means there is simply no session on this
      // request. An anonymous visitor needs no round trip to learn that.
      if (!data?.claims) {
        return { user: null, authError: null, source: 'no-session' };
      }
    }
    // Anything else (expired, symmetric keys, unverifiable) falls through.
  } catch {
    // getClaims rethrows errors that are not AuthErrors — a WebCrypto
    // DOMException, a malformed JWKS. Those must never 500 the middleware.
  }

  try {
    const { data, error } = await auth.getUser();
    return { user: data.user ?? null, authError: asError(error), source: 'get-user' };
  } catch (error) {
    return { user: null, authError: asError(error), source: 'get-user' };
  }
}
