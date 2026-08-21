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
 */

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

function asError(value: unknown): Error | null {
  if (value === null || value === undefined) return null;
  return value instanceof Error ? value : (value as Error);
}

export async function resolveMiddlewareIdentity(
  auth: MiddlewareAuth,
): Promise<MiddlewareIdentity> {
  try {
    const { data, error } = await auth.getClaims();

    if (!error) {
      const sub = data?.claims?.sub;
      if (typeof sub === 'string' && sub.length > 0) {
        // Signature verified locally. No network was involved.
        const metadata = data?.claims?.user_metadata as MiddlewareUser['user_metadata'];
        return {
          user: metadata ? { id: sub, user_metadata: metadata } : { id: sub },
          authError: null,
          source: 'claims',
        };
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
