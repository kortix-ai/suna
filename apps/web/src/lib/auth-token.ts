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
 */

import { createClient } from "@/lib/supabase/client";


/** Max retries for token acquisition (getSession + refreshSession fallback) */
const TOKEN_MAX_RETRIES = 2;
/** Base delay between retries (ms) — doubles each attempt */
const TOKEN_RETRY_BASE_DELAY = 300;
/** How long to cache a resolved token (ms) */
const TOKEN_CACHE_TTL = 30_000;
/** Extra retries while auth cookies/session hydrate on first load */
const TOKEN_HYDRATION_RETRIES = 3;
const TOKEN_HYDRATION_BASE_DELAY = 250;

// ── Token cache ──
let cachedToken: string | null = null;
let cachedAt = 0;
let bootstrapToken: string | null = null;

// ── Inflight deduplication ──
let inflight: Promise<string | null> | null = null;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get the current Supabase access token with caching + deduplication.
 *
 * Fast path: returns cached token if within TTL.
 * Slow path: deduplicates concurrent calls into a single auth roundtrip.
 */
export async function getSupabaseAccessToken(): Promise<string | null> {
	// Installer/bootstrap flow: server actions may set auth cookies without a
	// client-side Supabase session yet. Use an injected token until the client
	// session hydrates.
	if (bootstrapToken) {
		return bootstrapToken;
	}

	// Fast path: return cached token if still fresh
	if (cachedToken && Date.now() - cachedAt < TOKEN_CACHE_TTL) {
		return cachedToken;
	}

	// Deduplicate: if another call is already fetching, piggyback on it
	if (inflight) return inflight;

	inflight = fetchToken();
	try {
		const token = await inflight;
		cachedToken = token;
		cachedAt = Date.now();
		return token;
	} finally {
		inflight = null;
	}
}

/**
 * Retry token acquisition for initial auth hydration / stale cache recovery.
 */
export async function getSupabaseAccessTokenWithRetry(options?: {
	attempts?: number;
	baseDelayMs?: number;
	invalidateBetweenAttempts?: boolean;
}): Promise<string | null> {
	const {
		attempts = TOKEN_HYDRATION_RETRIES,
		baseDelayMs = TOKEN_HYDRATION_BASE_DELAY,
		invalidateBetweenAttempts = true,
	} = options ?? {};

	let token = await getSupabaseAccessToken();
	for (let attempt = 0; !token && attempt < attempts; attempt++) {
		await sleep(baseDelayMs * 2 ** attempt);
		if (invalidateBetweenAttempts) {
			invalidateTokenCache();
		}
		token = await getSupabaseAccessToken();
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
	cachedToken = token;
	cachedAt = token ? Date.now() : 0;
}

/**
 * Seed auth for setup/install flows that receive a JWT from server actions
 * before the browser Supabase client has established local session state.
 */
export function setBootstrapAuthToken(token: string | null): void {
	bootstrapToken = token;
	if (token) {
		setCachedAuthToken(token);
	}
}

/**
 * Decode a JWT's `exp` claim and report whether it's expired — or within
 * `skewSeconds` of expiring. Returns false when the token can't be parsed: let
 * the server be the judge rather than discard a token we simply can't read.
 */
function isJwtExpired(token: string, skewSeconds = 30): boolean {
	try {
		const payload = token.split('.')[1];
		if (!payload) return false;
		const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
		if (typeof json.exp !== 'number') return false;
		return Date.now() / 1000 >= json.exp - skewSeconds;
	} catch {
		return false;
	}
}

/** Internal: actually fetch the token from Supabase with retries. */
async function fetchToken(): Promise<string | null> {
	const supabase = createClient();

	for (let attempt = 0; attempt <= TOKEN_MAX_RETRIES; attempt++) {
		try {
			const {
				data: { session },
			} = await supabase.auth.getSession();

			// A present, non-expired token is good to use directly.
			if (session?.access_token && !isJwtExpired(session.access_token)) {
				return session.access_token;
			}

			// getSession() returns the STORED session even when its access_token
			// has already expired — it does not refresh here. Handing that dead
			// token to a caller produces a 401; on surfaces with no 401-recovery
			// (e.g. the PTY WebSocket) that becomes an endless 1006 reconnect loop.
			// So an expired-but-present session must be refreshed explicitly — the
			// old code only refreshed when the session was entirely null.
			if (attempt <= 1) {
				const {
					data: { session: refreshed },
				} = await supabase.auth.refreshSession();
				if (refreshed?.access_token) return refreshed.access_token;
			}
		} catch {
			// Network error or Supabase internal failure — retry after delay
		}

		// Don't delay after the last attempt
		if (attempt < TOKEN_MAX_RETRIES) {
			await new Promise((r) =>
				setTimeout(r, TOKEN_RETRY_BASE_DELAY * 2 ** attempt),
			);
		}
	}

	return null;
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
