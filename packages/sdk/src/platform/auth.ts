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

import { platformConfig } from './config';

/**
 * Get the current auth token. Delegates directly to `platformConfig().getToken()`
 * — any caching/deduplication the host wants happens inside that function.
 */
export async function getSupabaseAccessToken(): Promise<string | null> {
	return platformConfig().getToken();
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
export async function getSupabaseAccessTokenWithRetry(options?: {
	attempts?: number;
	baseDelayMs?: number;
	invalidateBetweenAttempts?: boolean;
}): Promise<string | null> {
	const attempts = Math.max(1, options?.attempts ?? 1);
	const baseDelayMs = options?.baseDelayMs ?? 0;
	const invalidateBetweenAttempts = options?.invalidateBetweenAttempts ?? false;

	let token: string | null = null;
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (attempt > 0) {
			if (invalidateBetweenAttempts) invalidateTokenCache();
			if (baseDelayMs > 0) await delay(baseDelayMs);
		}
		token = await platformConfig().getToken();
		if (token) return token;
	}
	return token;
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

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * The one long-lived streaming call reached through this fetch injection
 * point — `openEventStream` (`state/event-stream.ts`) drives the opencode
 * client's `global.event(...)` SSE endpoint, which hits `GET {runtimeUrl}/global/event`.
 * It manages its own lifecycle (a 15s heartbeat watchdog + explicit
 * abort/reconnect loop) and is meant to stay open far longer than any request
 * timeout — `withDefaultTimeout` exempts it below so a blanket timeout doesn't
 * tear the stream down every 30s.
 */
function isStreamingRequest(input: RequestInfo | URL): boolean {
  const url = input instanceof Request ? input.url : String(input);
  return url.includes('/global/event');
}

/**
 * Compose the request's own abort signal — a `Request` always carries one
 * (the caller's real signal, or a spec-default one that never fires) — with a
 * default 30s timeout, so a hung non-streaming call can't wedge a "Kortix as
 * a Backend" server-side handler forever. The SSE event stream is exempted
 * (see `isStreamingRequest`). Falls back to the caller's bare signal on a
 * runtime without `AbortSignal.any` (older Node/engines) — guarded so a
 * caller-supplied signal is never silently dropped.
 */
function withDefaultTimeout(input: RequestInfo | URL, init: RequestInit | undefined): AbortSignal | undefined {
  const callerSignal = input instanceof Request ? input.signal : init?.signal;
  if (isStreamingRequest(input)) return callerSignal ?? undefined;

  const timeoutSignal = AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS);
  if (!callerSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }
  return callerSignal;
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
