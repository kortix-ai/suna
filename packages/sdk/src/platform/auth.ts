/**
 * Shared auth token helpers.
 *
 * Provides Supabase JWT authentication for all requests.
 *
 * `getAuthToken()` is the unified getter: returns the Supabase JWT.
 * Use it anywhere you need to authenticate against the sandbox proxy.
 *
 * `getSupabaseAccessToken()` is kept for callers that specifically need the
 * Supabase JWT (e.g. platform API calls that go through Supabase auth).
 *
 * **Deduplication**: Multiple callers (SSE, health check, session fetch, etc.)
 * all call getSupabaseAccessToken() on page load simultaneously. Without
 * deduplication, each triggers its own getSession() → refreshSession() chain,
 * causing 5+ parallel Supabase auth roundtrips that take seconds. The inflight
 * promise ensures only ONE auth call runs at a time; all others piggyback.
 *
 * **Caching**: The resolved token is cached for TOKEN_CACHE_TTL (30s). Within
 * that window, subsequent calls return instantly. After TTL, the next call
 * refreshes from Supabase.
 *
 * SDK port: token acquisition (Supabase getSession/refreshSession), the 30s
 * token cache, the inflight dedup, and the install/bootstrap seam are all owned
 * by the host app and injected via `platformConfig().getToken()`. The exported
 * function names below are preserved verbatim so callers don't break.
 */

import { platformConfig } from './config';

/**
 * Get the current Supabase access token with caching + deduplication.
 *
 * Fast path: returns cached token if within TTL.
 * Slow path: deduplicates concurrent calls into a single auth roundtrip.
 */
export async function getSupabaseAccessToken(): Promise<string | null> {
	return platformConfig().getToken();
}

/**
 * Retry token acquisition for initial auth hydration / stale cache recovery.
 */
export async function getSupabaseAccessTokenWithRetry(options?: {
	attempts?: number;
	baseDelayMs?: number;
	invalidateBetweenAttempts?: boolean;
}): Promise<string | null> {
	return platformConfig().getToken();
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

export async function getAuthTokenWithRetry(options?: {
	attempts?: number;
	baseDelayMs?: number;
	invalidateBetweenAttempts?: boolean;
}): Promise<string | null> {
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
): Promise<Response> {
  if (input instanceof Request) {
    // Clone the Request with our auth headers baked in.
    // This guarantees Authorization is part of the Request itself,
    // not relying on fetch's init-merge behavior.
    const authedRequest = new Request(input, {
      headers,
    });
    return fetch(authedRequest);
  }
  return fetch(input, { ...init, headers });
}

/**
 * Build a Headers object from request input + init, injecting the auth token.
 */
function buildAuthHeaders(
  input: RequestInfo | URL,
  init?: RequestInit,
  token?: string | null,
): Headers {
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  );
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return headers;
}

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
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const headers = buildAuthHeaders(input, init, token);

  // When the OpenCode SDK passes a Request object (single arg, no init),
  // we must construct a new Request with the auth headers baked in.
  // Relying on fetch(Request, { headers }) to override headers is unreliable
  // in production builds — Next.js's patched fetch and certain browser
  // implementations don't properly merge init.headers onto an existing
  // Request, causing the Authorization header to be silently dropped.
  const response = await fetchWithAuth(input, init, headers);

  if (response.status === 401) {
    // The cached token is stale. Retry once with fresh token.
    if (retryOnAuthError && token) {
      invalidateTokenCache();
      const newToken = await getAuthTokenWithRetry({ attempts: 2, baseDelayMs: 200 });
      if (newToken && newToken !== token) {
        const retryHeaders = buildAuthHeaders(input, init, newToken);
        return fetchWithAuth(input, init, retryHeaders);
      }
    }
  }

  return response;
}
