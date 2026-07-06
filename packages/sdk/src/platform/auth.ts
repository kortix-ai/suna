/**
 * Shared auth token helpers.
 *
 * Every function below is a thin delegate to `platformConfig().getToken()` —
 * the SDK holds no token state of its own. Token acquisition (Supabase
 * getSession/refreshSession or any other provider), caching, deduplicating
 * concurrent callers (SSE, health check, session fetch, etc. all racing for a
 * token on page load), and the install/bootstrap seam are entirely the host
 * app's responsibility, implemented inside the `getToken` it passes to
 * `configureKortix`/`createKortix`. A host that wants the old 30s-TTL +
 * inflight-dedup behavior re-implements it in its own `getToken`; the SDK
 * itself does not cache, dedupe, or retry beyond calling `getToken()` again.
 *
 * `getAuthToken()` is the unified getter: returns whatever token the host's
 * `getToken()` resolves. `getSupabaseAccessToken()` is kept as an alias for
 * callers that historically asked for "the Supabase token" specifically —
 * same delegate, same value.
 *
 * `invalidateTokenCache()` / `setCachedAuthToken()` / `setBootstrapAuthToken()`
 * are no-ops here (there is no SDK-side cache to invalidate or seed); they're
 * kept as exported names so existing call sites compile unchanged, and a host
 * that layers its own caching on top of `getToken()` can wire these to that
 * cache if it wants the "invalidate on 401" / "seed before hydration" hooks to
 * do something.
 */

import {
	buildAuthHeaders,
	syntheticUnauthenticatedResponse,
	withDefaultTimeout,
	withTokenRetry,
	type TokenRetryOptions,
} from './auth-core';
import { platformConfig } from './config';

/**
 * Get the current auth token. Delegates directly to `platformConfig().getToken()`
 * — any caching/deduplication the host wants happens inside that function.
 */
export async function getSupabaseAccessToken(): Promise<string | null> {
	return platformConfig().getToken();
}

/**
 * Retry variant — actually retries now. Previously accepted `attempts`/
 * `baseDelayMs`/`invalidateBetweenAttempts` and silently ignored all three
 * (always a single `getToken()` call), which quietly broke every caller that
 * depended on retry semantics around a flaky/cold token provider (e.g. right
 * after sign-in, before a host's own session has hydrated — see the retry
 * call in `authenticatedFetch`'s 401 handler below).
 *
 * Retries up to `attempts` times (default 1 = no retry) until `getToken()`
 * returns a truthy token, waiting `baseDelayMs` between attempts (default 0).
 * When `invalidateBetweenAttempts` is set, calls `invalidateTokenCache()`
 * before each retry — a no-op in this file (there's no SDK-side cache), but
 * kept as a real call so a host that layers its own cache on `getToken()` (and
 * wires `invalidateTokenCache`/`setCachedAuthToken` to it, per this file's
 * top-of-file doc comment) gets invalidated between attempts as intended.
 */
export async function getSupabaseAccessTokenWithRetry(
	options?: TokenRetryOptions,
): Promise<string | null> {
	// The retry loop itself lives in `auth-core.ts` (pure, un-mockable in
	// tests) — this delegate just binds it to the live platform config.
	return withTokenRetry(() => platformConfig().getToken(), options, invalidateTokenCache);
}

/**
 * Invalidate the cached token (e.g. after a 401 response).
 * The next getSupabaseAccessToken() call will fetch fresh.
 */
export function invalidateTokenCache(): void {
	setCachedAuthToken(null);
}

/**
 * Sync the resolved auth token cache without affecting bootstrap mode.
 */
export function setCachedAuthToken(token: string | null): void {
	// Token caching/refresh is owned by the host via platformConfig().getToken().
}

/**
 * Seed auth for setup/install flows that receive a JWT from server actions
 * before the browser Supabase client has established local session state.
 */
export function setBootstrapAuthToken(token: string | null): void {
	// Token acquisition is owned by the host via platformConfig().getToken().
}

/**
 * Unified auth token getter.
 *
 * Returns the Supabase JWT. All requests go through kortix-api which
 * authenticates via Supabase JWT — no additional sandbox lock/key needed.
 */
export async function getAuthToken(): Promise<string | null> {
  return getSupabaseAccessToken();
}

export async function getAuthTokenWithRetry(
	options?: TokenRetryOptions,
): Promise<string | null> {
	return getSupabaseAccessTokenWithRetry(options);
}

// ── Shared auth-injecting fetch ──

/**
 * Execute fetch with auth headers, properly handling Request objects.
 *
 * When `input` is a Request (e.g. from the OpenCode SDK), we construct a new
 * Request with the auth headers merged in, rather than passing headers via the
 * second `init` argument. This avoids a production-only issue where
 * `fetch(Request, { headers })` silently drops the init headers.
 */
function fetchWithAuth(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  headers: Headers,
  signal?: AbortSignal,
): Promise<Response> {
  if (input instanceof Request) {
    // Clone the Request with our auth headers baked in.
    // This guarantees Authorization is part of the Request itself,
    // not relying on fetch's init-merge behavior.
    const authedRequest = new Request(input, {
      headers,
      ...(signal ? { signal } : {}),
    });
    return fetch(authedRequest);
  }
  return fetch(input, { ...init, headers, ...(signal ? { signal } : {}) });
}

// Timeout composition, streaming exemption, and header building live in
// `auth-core.ts` (pure + directly unit-tested there); this file wires them to
// the live token seam.

/**
 * Shared authenticated fetch — injects auth tokens and handles 401 responses.
 *
 * Centralizes the pattern duplicated across opencode-sdk, use-sandbox-connection,
 * and server-selector. All three auth injection points now go through this.
 *
 * Behavior:
 *   1. Gets the current auth token (Supabase JWT)
 *   2. Injects it as Bearer token on the request
 *   3. On 401: invalidates the token cache, gets fresh, retries once
 *
 * Options:
 *   - `retryOnAuthError`: if false, skips stale-token retry (default: true)
 */
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: {
    retryOnAuthError?: boolean;
  },
): Promise<Response> {
  const { retryOnAuthError = true } = options ?? {};

  const token = await getAuthTokenWithRetry();

  // Still no token — return a synthetic 401 response instead of sending a
  // naked request. Safe for all callers including the OpenCode SDK which
  // expects fetch() semantics (returns Response, never throws).
  if (!token) {
    return syntheticUnauthenticatedResponse();
  }

  const headers = buildAuthHeaders(input, init, token);
  // 30s default timeout for everything EXCEPT the long-lived SSE event
  // stream (see `withDefaultTimeout`) — a "Kortix as a Backend" wrapper must
  // never have a hung sandbox/daemon request wedge its handler forever.
  const signal = withDefaultTimeout(input, init);

  // When the OpenCode SDK passes a Request object (single arg, no init),
  // we must construct a new Request with the auth headers baked in.
  // Relying on fetch(Request, { headers }) to override headers is unreliable
  // in production builds — Next.js's patched fetch and certain browser
  // implementations don't properly merge init.headers onto an existing
  // Request, causing the Authorization header to be silently dropped.
  const response = await fetchWithAuth(input, init, headers, signal);

  if (response.status === 401) {
    // The cached token is stale. Retry once with fresh token.
    if (retryOnAuthError && token) {
      invalidateTokenCache();
      const newToken = await getAuthTokenWithRetry({ attempts: 2, baseDelayMs: 200 });
      if (newToken && newToken !== token) {
        const retryHeaders = buildAuthHeaders(input, init, newToken);
        return fetchWithAuth(input, init, retryHeaders, signal);
      }
    }
  }

  return response;
}
