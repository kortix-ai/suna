import { isAuthApiError, isAuthSessionMissingError } from '@supabase/supabase-js';

/**
 * Whether an error from `supabase.auth.getUser()` is the auth server's verdict
 * that the session is dead — as opposed to the round trip failing.
 *
 * Definitive (sign out):
 * - `AuthApiError` 401: the JWT was rejected (expired past refresh, user
 *   deleted after a DB reset, signature mismatch).
 * - `AuthApiError` 403: the session row behind a still-valid JWT is gone
 *   (`session_not_found`).
 * - `AuthSessionMissingError`: there was nothing to validate.
 *
 * NOT definitive (keep the session, try again on the next load):
 * - `AuthRetryableFetchError`, status 0: the fetch never completed. This is
 *   what an ABORTED request becomes — the document navigated away or closed
 *   while `/auth/v1/user` was in flight. The GitHub identity-proof popup
 *   (`app/(auth)/auth/github-connect`) does exactly that: it posts its token to
 *   the opener and closes itself 200ms later, and it runs the same
 *   `AuthProvider` as every other page. On a slow network its `getUser()`
 *   aborted, the provider treated that as a stale session and called
 *   `signOut()`, which cleared the cookie EVERY tab shares and broadcast
 *   `SIGNED_OUT` to the opener — "verify with GitHub logs me out"
 *   (dev, 2026-09-17, reproduced with Slow 3G throttling on the popup).
 * - 5xx / 429: the auth server is down or rate limiting; it said nothing
 *   about this session.
 * - Anything without an HTTP status.
 */
export function isDefinitiveSessionRejection(error: unknown): boolean {
  if (!error) return false;
  if (isAuthSessionMissingError(error)) return true;
  if (isAuthApiError(error)) {
    if (error.status === 401 && isMissingBearerRejection(error)) return false;
    return error.status === 401 || error.status === 403;
  }
  return false;
}

/**
 * GoTrue's "the request carried no Bearer at all" verdict: 401 with code
 * `no_authorization`, message "This endpoint requires a valid Bearer token"
 * (message matched too — an older server/SDK mix may leave the code absent).
 *
 * `AuthProvider` only calls `getUser()` after `getSession()` returned a
 * session, so auth-js DID attach the bearer — this verdict means the header
 * vanished in transit, not that the JWT was rejected. KRTX-1693 (dev,
 * 2026-10-07): a probe harness stored the dev-gate Basic credentials as
 * browser httpCredentials; GoTrue/Kong's 401s carry a Basic challenge, so
 * every Supabase request went out `Authorization: Basic <dev-gate>` and the
 * provider signed out — and wiped the cookie of — a perfectly valid session:
 * "dev sign-in doesn't persist". Privacy extensions and stripping proxies
 * produce the same verdict. Keeping the session is safe: the cookie and
 * in-memory session are untouched and the next load retries `getUser()`.
 */
function isMissingBearerRejection(error: { code?: string; message?: string }): boolean {
  if (error.code === 'no_authorization') return true;
  return (
    !error.code &&
    !!error.message &&
    error.message.toLowerCase().includes('requires a valid bearer token')
  );
}
