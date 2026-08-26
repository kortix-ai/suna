/**
 * Pure, dependency-free building blocks for `auth.ts` — extracted so they can
 * be unit-tested against the REAL implementation regardless of test-file
 * ordering.
 *
 * Why this file exists: several test suites register process-wide
 * `mock.module('../core/http/auth', …)` stubs (Bun's `mock.module` replaces a
 * specifier for the remainder of the process, for every importer — see the
 * note in `opencode/client.test.ts`). Any test that wants to exercise the real
 * retry/timeout semantics therefore can't import them from `./auth` — on some
 * Bun versions/orderings it would receive a stub. Nothing mocks THIS module,
 * so `auth-core.test.ts` always tests the genuine article, and `auth.ts` stays
 * a thin delegating shell whose behavior is pinned here.
 */

/** Options accepted by the token-retry helpers (`getAuthTokenWithRetry` et al). */
export interface TokenRetryOptions {
	attempts?: number;
	baseDelayMs?: number;
	invalidateBetweenAttempts?: boolean;
}

const CLIENT_SOURCES = new Set(['api', 'cli', 'mobile', 'web']);

export function normalizeClientSource(value?: string): string | null {
	const normalized = value?.trim().toLowerCase();
	return normalized && CLIENT_SOURCES.has(normalized) ? normalized : null;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry `getToken` up to `attempts` times (default 1 = no retry) until it
 * returns a truthy token, waiting `baseDelayMs` between attempts. When
 * `invalidateBetweenAttempts` is set, `onInvalidate` runs before each retry —
 * a host that layers its own cache on `getToken` wires cache invalidation
 * there. Returns the last (possibly falsy) result after exhausting attempts.
 */
export async function withTokenRetry(
	getToken: () => Promise<string | null>,
	options?: TokenRetryOptions,
	onInvalidate?: () => void,
): Promise<string | null> {
	const attempts = Math.max(1, options?.attempts ?? 1);
	const baseDelayMs = options?.baseDelayMs ?? 0;
	const invalidateBetweenAttempts = options?.invalidateBetweenAttempts ?? false;

	let token: string | null = null;
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (attempt > 0) {
			if (invalidateBetweenAttempts) onInvalidate?.();
			if (baseDelayMs > 0) await delay(baseDelayMs);
		}
		token = await getToken();
		if (token) return token;
	}
	return token;
}

/**
 * A HANG detector, not a throughput limit.
 *
 * 30s was both, and the second role broke sessions: a transcript page that was
 * 7-19 MB of inline attachment bytes took 23-30 s to arrive and was killed at
 * exactly 30.00 s — then retried, and killed again, forever (essentia,
 * 2026-08-24, network panel: five reads in a row at 29.23-30.08 s). The bytes
 * are gone now (`stripInlineAttachmentBytes`), which is the real fix; this
 * ceiling is raised so the next large-but-legitimate response is not
 * manufactured into a failure by the client that asked for it. A wedged
 * sandbox is still caught — apps/api's own proxy budget is 50 s.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

/**
 * The one long-lived streaming call reached through the auth fetch injection
 * point — `openEventStream` (`state/event-stream.ts`) drives the opencode
 * client's `global.event(...)` SSE endpoint (`GET {runtimeUrl}/global/event`).
 * It manages its own lifecycle (heartbeat watchdog + explicit abort/reconnect
 * loop) and must stay open far longer than any request timeout.
 */
export function isStreamingRequest(input: RequestInfo | URL): boolean {
	const url = input instanceof Request ? input.url : String(input);
	if (url.includes('/global/event')) return true;
	// The Kortix session stream (`GET .../sessions/:sid/stream`, read by
	// `core/rest/projects-client/session-stream.ts`). Same reason as
	// `/global/event`: it is a never-ending `text/event-stream` that owns its own
	// lifecycle, so a 30 s request deadline would kill every healthy one on
	// schedule. Matched on the path segment, and anchored on `/sessions/` so a
	// route that merely CONTAINS the word "stream" is not accidentally exempted.
	return /\/sessions\/[^/?#]+\/stream(?:$|[?#])/.test(url);
}

/**
 * Compose the request's own abort signal with a default 30s timeout, so a
 * hung non-streaming call can't wedge a "Kortix as a Backend" server-side
 * handler forever. The SSE event stream is exempted (see
 * `isStreamingRequest`): its caller signal — if any — passes through
 * untouched. Falls back to the caller's bare signal on a runtime without
 * `AbortSignal.any` (older Node/engines) — guarded so a caller-supplied
 * signal is never silently dropped.
 */
export function withDefaultTimeout(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): AbortSignal | undefined {
	const callerSignal = input instanceof Request ? input.signal : init?.signal;
	if (isStreamingRequest(input)) return callerSignal ?? undefined;

	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (!callerSignal) return timeoutSignal;
	if (typeof AbortSignal.any === 'function') {
		return AbortSignal.any([callerSignal, timeoutSignal]);
	}
	return callerSignal;
}

/**
 * Build a Headers object from request input + init, injecting the auth token
 * as a Bearer Authorization header (unless one is already present).
 */
export function buildAuthHeaders(
	input: RequestInfo | URL,
	init?: RequestInit,
	token?: string | null,
	clientSource?: string,
): Headers {
	const headers = new Headers(input instanceof Request ? input.headers : undefined);
	if (init?.headers) {
		new Headers(init.headers).forEach((value, key) => {
			headers.set(key, value);
		});
	}
	if (token && !headers.has('Authorization')) {
		headers.set('Authorization', `Bearer ${token}`);
	}
	const normalizedClientSource = normalizeClientSource(clientSource);
	if (normalizedClientSource && !headers.has('X-Kortix-Client')) {
		headers.set('X-Kortix-Client', normalizedClientSource);
	}
	return headers;
}

/**
 * The synthetic 401 returned when no token is available — safe for all
 * callers including the OpenCode SDK, which expects fetch() semantics
 * (returns a Response, never throws), and it means the request never goes
 * out on the wire unauthenticated.
 */
export function syntheticUnauthenticatedResponse(): Response {
	return new Response(JSON.stringify({ error: 'Not authenticated' }), {
		status: 401,
		headers: { 'Content-Type': 'application/json' },
	});
}
