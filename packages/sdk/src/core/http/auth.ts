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
	syntheticUnauthenticatedResponse,
	withTokenRetry,
	type TokenRetryOptions,
} from '../../platform/auth-core';
import { AuthError } from './api/errors';
import { platformConfig } from './config';
import { send } from './transport';

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
 *     detector (`uploadTimeoutMsForBytes` in `core/files/client.ts`). A caller
 *     `init.signal` still composes with it; whichever fires first wins.
 */
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: {
    retryOnAuthError?: boolean;
    timeoutMs?: number;
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
