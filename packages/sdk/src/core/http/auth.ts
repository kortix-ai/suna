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
 * `invalidateTokenCache()` calls the host's `getToken.invalidate(lastToken)`.
 * A host that caches MUST implement `invalidate` (web and mobile do), or a 401
 * replay and the SSE auth recovery re-read the same dead token.
 * `setCachedAuthToken(token)` / `setBootstrapAuthToken()` are inert: the SDK
 * has no cache to seed.
 */

import {
	syntheticUnauthenticatedResponse,
	withTokenRetry,
	type TokenRetryOptions,
} from '../../platform/auth-core';
import { AuthError } from './api/errors';
import { platformConfig } from './config';
import { hostToken, invalidateHostToken, send } from './transport';

/**
 * Get the current auth token. Delegates directly to `platformConfig().getToken()`
 * — any caching/deduplication the host wants happens inside that function.
 */
export async function getSupabaseAccessToken(): Promise<string | null> {
	return hostToken();
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
 * before each retry, which reaches the host's `getToken.invalidate`.
 */
export async function getSupabaseAccessTokenWithRetry(
	options?: TokenRetryOptions,
): Promise<string | null> {
	// The retry loop itself lives in `auth-core.ts` (pure, un-mockable in
	// tests) — this delegate just binds it to the live platform config.
	return withTokenRetry(() => platformConfig().getToken(), options, invalidateTokenCache);
}

/**
 * Invalidate the token the host last issued (e.g. after a 401 response).
 * Calls the host's `getToken.invalidate(token)`, so the next
 * `getSupabaseAccessToken()` fetches fresh. A host whose `getToken` has no
 * `invalidate` has no cache to clear: nothing happens.
 */
export function invalidateTokenCache(): void {
	invalidateHostToken();
}

/**
 * `null` invalidates like `invalidateTokenCache()`. A token is ignored: the SDK
 * holds no token cache to seed.
 * @deprecated Seed the host's own `getToken` instead.
 */
export function setCachedAuthToken(token: string | null): void {
	if (token === null) invalidateHostToken();
}

/**
 * Inert: the SDK holds no token state, so there is nothing to seed.
 * @deprecated Return the bootstrap token from the host's own `getToken`.
 */
export function setBootstrapAuthToken(_token: string | null): void {}

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
 * `fetch` with the Kortix auth and header policy, for the session runtime,
 * files and any other absolute URL. A thin adapter over `send()`
 * (`./transport.ts`), which owns the token, the headers (bearer, client
 * surface, admin bypass, act-as), the default deadline and the one 401 replay.
 *
 * Fetch semantics: it resolves a `Response` for every HTTP status and never
 * throws for a missing token. Without a token it resolves a synthetic 401 and
 * sends nothing, so the OpenCode client (which expects `fetch`) is safe.
 *
 * Options:
 *   - `retryOnAuthError`: replay a 401 once with a fresh token (default `true`).
 *   - `timeoutMs`: override the default deadline (`DEFAULT_FETCH_TIMEOUT_MS`)
 *     for bodies large enough that it is a throughput limit rather than a hang
 *     detector (`uploadTimeoutMsForBytes` in `core/files/client.ts`), or `null`
 *     for no transport deadline — the caller's signal is the only one. A caller
 *     `init.signal` still composes with it; whichever fires first wins.
 */
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: {
    retryOnAuthError?: boolean;
    timeoutMs?: number | null;
  },
): Promise<Response> {
  try {
    return await send(input, init, {
      retryOnAuthError: options?.retryOnAuthError,
      timeoutMs: options?.timeoutMs,
    });
  } catch (error) {
    if (error instanceof AuthError) return syntheticUnauthenticatedResponse();
    throw error;
  }
}
