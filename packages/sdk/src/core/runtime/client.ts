/**
 * The session runtime client cache.
 *
 * Provides a `getClient()` function that returns a `RuntimeClient` instance
 * pointed at the currently active server URL. Automatically recreates the
 * client when the server URL changes.
 *
 * Auth tokens are injected via the shared `authenticatedFetch` from auth-token.ts.
 * All 401 handling (sandbox auth detection + stale token retry) is centralized there.
 */

import {
	createRuntimeRestClient,
	type RuntimeClient,
	type RuntimeClientConfig,
} from "./runtime-rest-client";

// The types a host reads runtime data with: the Kortix transcript
// (`kortix.transcript.v1`) and the runtime surfaces the SDK still reaches
// through the compatibility routes. Both are declared in this package; a host
// imports them from `@kortix/sdk` and never from a harness's own SDK.
export * from "./transcript-types";
export type * from "./runtime-types";
// The runtime REST client (type only: a host never builds its own client).
export type {
	RuntimeClient,
	RuntimeClientConfig,
	RuntimeEventMessage,
	RuntimeEventStreamOptions,
	RuntimeEventTransport,
	RuntimeRequestOptions,
	RuntimeResult,
} from "./runtime-rest-client";
export type { createRuntimeRestClient as createRuntimeClient };
/** @deprecated Renamed to `RuntimeClient`. Removed in the next major. */
export type OpencodeClient = RuntimeClient;
/** @deprecated Renamed to `RuntimeClientConfig`. Removed in the next major. */
export type OpencodeClientConfig = RuntimeClientConfig;
/** @deprecated Renamed to `createRuntimeClient`. Removed in the next major. */
export type createOpencodeClient = typeof createRuntimeRestClient;

import { authenticatedFetch } from "../http/auth";
import { isConfigured } from "../http/config";
import { platformEventTransport } from "../stream/platform-event-transport";
import { getActiveRuntimeUrl } from "../session/server-store/active";
import { ApiError } from "../http/api/errors";

// Sandbox env/secrets client (`GET/PUT/DELETE /env`), the `/kortix/triggers`
// wrapper, the Kortix-native PTY client (`/kortix/pty`, independent of
// whatever agent runtime is running), and the kortix-master
// project-management client (`/kortix/tasks`, `/kortix/tickets`,
// `/kortix/projects`, `/kortix/services`, ...) all live in sibling modules,
// re-exported here so hosts only ever import daemon operations from this one
// subpath.
export { listEnv, setEnv, deleteEnv, env } from "./env";
export { triggersRequest } from "./triggers";
export {
	listKortixPty,
	createKortixPty,
	updateKortixPty,
	removeKortixPty,
	getKortixPtyWebSocketUrl,
	kortixPty,
	classifyPtyClose,
	sanitizePtyChunk,
	type KortixPty,
	type PtyCloseAction,
} from "./pty";
export * from "./kortix-master";


/**
 * Per-URL client cache. Unlike `getClient()` (which tracks only the single
 * active server), this keeps one client alive PER sandbox URL so we can talk to
 * several session sandboxes in parallel — every open session stays connected to
 * its own runtime at the same time. Keyed by absolute base URL.
 */
const clientsByUrl = new Map<string, RuntimeClient>();
/** One client per sandbox URL; a window that cycles hundreds of sessions
 *  forgets the least recently used. A forgotten client in use is simply
 *  recreated on its next `getClientForUrl`. */
const MAX_CLIENTS_BY_URL = 256;

/**
 * Thrown when the active runtime's sandbox URL hasn't resolved yet (e.g. a
 * cloud sandbox is still provisioning). Distinct from a plain `Error` so
 * callers (`classifySendError` in `../react/use-session`) can classify this
 * specific "try again in a moment" condition with `instanceof` instead of
 * string-matching the message. The message text is unchanged for any
 * remaining string-match fallback.
 */
export class RuntimeNotReadyError extends Error {
	constructor(message = '[opencode-sdk] Server URL not ready — sandbox is still loading') {
		super(message);
		this.name = 'RuntimeNotReadyError';
	}
}

/**
 * Get (or create) the SDK client for the current active server.
 * Safe to call from non-React contexts (API modules, etc.).
 *
 * Throws if the server URL isn't resolved yet (e.g. cloud sandbox still
 * loading). React Query hooks will catch this and retry automatically.
 */
export function getClient(): RuntimeClient {
	const url = getActiveRuntimeUrl();
	if (!url) {
		throw new RuntimeNotReadyError();
	}
	// One factory. "The active runtime" is just the current session's URL, and
	// getClientForUrl caches per URL — so there is no separate global singleton to
	// keep in sync, and no client to "reset" when the current session changes.
	return getClientForUrl(url);
}

/**
 * Get (or create) a client bound to a SPECIFIC sandbox URL, independent of the
 * globally active server. Use this to run multiple session sandboxes in
 * parallel (e.g. one live SSE stream per open session). Clients are cached per
 * URL so repeat calls are cheap and share one connection.
 *
 * ALWAYS injects the platform bearer token via `authenticatedFetch` — every
 * sandbox URL the SDK builds is a `${backendUrl}/p/{externalId}/{port}` proxy
 * route, so it always needs the same auth as any other backend call (the
 * daemon has no separate auth of its own). There is no "public sandbox URL"
 * case that would justify a bare, unauthenticated fetch — sending one would
 * silently 401/leak. If the host never called `configureKortix()`, fail loudly
 * instead of quietly sending an unauthenticated request.
 */
export function getClientForUrl(url: string): RuntimeClient {
	if (!url) {
		throw new Error('[opencode-sdk] getClientForUrl called without a url');
	}
	const existing = clientsByUrl.get(url);
	if (existing) {
		// Touch: Map order is the LRU order.
		clientsByUrl.delete(url);
		clientsByUrl.set(url, existing);
		return existing;
	}

	if (!isConfigured()) {
		throw new Error(
			'[opencode-sdk] No auth token provider configured — call configureKortix()/createKortix() before talking to a sandbox runtime.',
		);
	}

	const client = createRuntimeRestClient({
		baseUrl: url,
		fetch: authenticatedFetch as typeof fetch,
		eventTransport: platformEventTransport,
	});
	clientsByUrl.set(url, client);
	if (clientsByUrl.size > MAX_CLIENTS_BY_URL) {
		clientsByUrl.delete(clientsByUrl.keys().next().value as string);
	}
	return client;
}

/**
 * Drop a per-URL client (e.g. when a session sandbox is closed). No-op if the
 * URL was never cached.
 */
export function dropClientForUrl(url: string): void {
	clientsByUrl.delete(url);
}

/**
 * Drop cached clients so the next call recreates them (e.g. after a token change).
 * No global singleton anymore — this clears the per-URL cache.
 */
export function resetClient(): void {
	clientsByUrl.clear();
}

/**
 * Per-URL client cache for PUBLIC, unauthenticated access — same caching shape
 * as `getClientForUrl`, but talks to the sandbox with a bare `fetch` instead
 * of `authenticatedFetch`.
 *
 * `getClientForUrl` assumes its URL is an authenticated
 * `${backendUrl}/p/{externalId}/{port}` proxy route that always needs the
 * platform bearer token — that's correct for every session a logged-in host
 * talks to. This is the one legitimate exception: a route the backend has
 * deliberately made reachable by a LOGGED-OUT visitor (e.g. the unauthenticated
 * public-share proxy, `/v1/p/public-share/{token}/{port}` — see
 * `apps/api/src/sandbox-proxy/routes/public-share.ts`, which strips the
 * `authorization` header on the way through anyway). Routing that through
 * `authenticatedFetch` doesn't just send a redundant header — for an anonymous
 * visitor with no token, `authenticatedFetch` synthesizes a 401 response
 * WITHOUT ever making the network call (see `platform/auth.ts`), which breaks
 * the primary audience of a public share link before the request goes out.
 *
 * Never point this at an authenticated proxy route — that would send a naked,
 * unauthenticated request somewhere that expects a bearer token.
 */
const publicClientsByUrl = new Map<string, RuntimeClient>();

/**
 * Get (or create) a PUBLIC, unauthenticated client bound to a specific base
 * URL. See the {@link publicClientsByUrl} comment for why this exists as a
 * deliberate, separate cache/factory rather than a flag on `getClientForUrl`.
 */
export function getPublicClientForUrl(url: string): RuntimeClient {
	if (!url) {
		throw new Error('[opencode-sdk] getPublicClientForUrl called without a url');
	}
	const existing = publicClientsByUrl.get(url);
	if (existing) return existing;

	const client = createRuntimeRestClient({ baseUrl: url, fetch });
	publicClientsByUrl.set(url, client);
	return client;
}

/**
 * Drop a cached public client (e.g. when a share link is revoked). No-op if
 * the URL was never cached.
 */
export function dropPublicClientForUrl(url: string): void {
	publicClientsByUrl.delete(url);
}

/** Drop cached public clients so the next call recreates them. */
export function resetPublicClient(): void {
	publicClientsByUrl.clear();
}

async function daemonErrorMessage(res: Response): Promise<string> {
	const text = await res.text().catch(() => '');
	try {
		const parsed = JSON.parse(text) as { error?: string; message?: string };
		return parsed?.error || parsed?.message || text || res.statusText || `HTTP ${res.status}`;
	} catch {
		return text || res.statusText || `HTTP ${res.status}`;
	}
}

export type SystemReloadMode = 'dispose-only' | 'full';

export interface SystemReloadResult {
	success: boolean;
	mode: SystemReloadMode;
	steps: string[];
	errors: string[];
}

/**
 * Apply the sandbox's current config to its running agent runtime.
 *
 * `'dispose-only'` — `POST /global/dispose`. opencode re-reads its config FILE
 * from disk, in-process: same pid, ~51ms, and an in-flight turn survives.
 * `'full'` — `POST /kortix/refresh`. The daemon pulls the workspace and restarts
 * opencode. Slower (~8s) and it DOES end the turn in flight, but it is the only
 * client-reachable path that re-runs spawn-time setup.
 *
 * Both endpoints were verified against opencode 1.17.11 on 2026-08-03 and
 * `/global/dispose` re-verified against the pinned 1.18.19 on 2026-08-20.
 *
 * This used to POST `/kortix/services/system/reload`, which does not exist. That
 * path falls through to opencode's SPA catch-all, so the call got `200` with an
 * HTML body and died on `response.json()` — both command-palette entries built
 * on it have never worked. Mobile was unaffected because it calls
 * `/global/dispose` directly.
 *
 * The `ok`-plus-`content-type` check below is why that failure is not
 * repeatable: against this server a 200 alone does not mean the route exists.
 */
export async function systemReload(mode: SystemReloadMode): Promise<SystemReloadResult> {
	const url = getActiveRuntimeUrl();
	if (!url) {
		throw new ApiError('[opencode-sdk] Server URL not ready — sandbox is still loading', {
			code: 'RUNTIME_UNAVAILABLE',
		});
	}
	const path = mode === 'full' ? '/kortix/refresh' : '/global/dispose';
	const response = await authenticatedFetch(`${url}${path}`, { method: 'POST' });
	const contentType = response.headers.get('content-type') ?? '';
	// Case-insensitive, and `application/<vendor>+json` counts. A false negative
	// here would report a working endpoint as missing.
	const isJson = /^application\/([\w.+-]+\+)?json\b/i.test(contentType.trim());
	if (!response.ok) {
		throw new ApiError(`System reload failed (${response.status}): ${await daemonErrorMessage(response)}`, {
			status: response.status,
			response,
			code: 'RUNTIME_UNAVAILABLE',
		});
	}
	if (!isJson) {
		// A 200 with HTML is opencode's SPA catch-all — the route is not there.
		throw new ApiError(`System reload endpoint is unavailable on this sandbox (${path})`, {
			status: response.status,
			response,
			code: 'RUNTIME_UNAVAILABLE',
		});
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch (err) {
		// JSON content-type with an unparseable body is a protocol regression, not
		// a reload that declined. Surface it with the parse detail instead of
		// flattening it into a generic "did not confirm".
		throw new ApiError(
			`System reload returned malformed JSON from ${path}: ${err instanceof Error ? err.message : String(err)}`,
			{ status: response.status, response, code: 'RUNTIME_UNAVAILABLE' },
		);
	}
	// `/global/dispose` answers a bare `true`; `/kortix/refresh` answers an
	// object with `ok`. Neither matches SystemReloadResult, so build it here
	// rather than changing a shape callers already consume.
	const success = body === true || (typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true);
	return {
		success,
		mode,
		steps: success ? [mode === 'full' ? 'refreshed workspace and restarted runtime' : 'reloaded config in place'] : [],
		errors: success ? [] : [`the sandbox did not confirm the reload (${path})`],
	};
}
