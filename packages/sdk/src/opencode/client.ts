/**
 * OpenCode SDK client singleton.
 *
 * Provides a `getClient()` function that returns an `OpencodeClient` instance
 * pointed at the currently active server URL. Automatically recreates the
 * client when the server URL changes.
 *
 * Auth tokens are injected via the shared `authenticatedFetch` from auth-token.ts.
 * All 401 handling (sandbox auth detection + stale token retry) is centralized there.
 */

import {
	createOpencodeClient,
	type OpencodeClient,
} from "@opencode-ai/sdk/v2/client";

// Re-export the ENTIRE opencode v2 type surface through the SDK, so a host app
// imports `Event`, `Part`, `Message`, `Session`, `Pty`, `Config`, `Agent`,
// `ProviderListResponse`, … from `@kortix/sdk/opencode-client` and NEVER from
// `@opencode-ai/sdk` directly. `packages/sdk/package.json` pins the package's
// OWN `@opencode-ai/sdk` dependency to one exact version — it does not, by
// itself, force every workspace package to resolve that same version (pnpm can
// still hoist a different range elsewhere). What actually "pins everyone" is
// that host code only ever imports opencode types through this re-export, so
// there is exactly one set of type declarations in play for host code, even if
// multiple `@opencode-ai/sdk` copies exist on disk.
export type * from "@opencode-ai/sdk/v2/client";
export type { OpencodeClient };

import { authenticatedFetch } from "../platform/auth";
import { isConfigured } from "../platform/config";
import { getActiveOpenCodeUrl } from "../state/server-store/active";
import { ApiError } from "../platform/api/errors";

// Sandbox env/secrets client (`GET/PUT/DELETE /env`), the `/kortix/triggers`
// wrapper, and the kortix-master project-management client (`/kortix/tasks`,
// `/kortix/tickets`, `/kortix/projects`, `/kortix/services`, ...) all live in
// sibling modules, re-exported here so hosts only ever import daemon
// operations from this one subpath.
export { listEnv, setEnv, deleteEnv, env } from "./env";
export { triggersRequest } from "./triggers";
export * from "./kortix-master";


/**
 * Per-URL client cache. Unlike `getClient()` (which tracks only the single
 * active server), this keeps one client alive PER sandbox URL so we can talk to
 * several session sandboxes in parallel — every open session stays connected to
 * its own runtime at the same time. Keyed by absolute base URL.
 */
const clientsByUrl = new Map<string, OpencodeClient>();

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
export function getClient(): OpencodeClient {
	const url = getActiveOpenCodeUrl();
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
export function getClientForUrl(url: string): OpencodeClient {
	if (!url) {
		throw new Error('[opencode-sdk] getClientForUrl called without a url');
	}
	const existing = clientsByUrl.get(url);
	if (existing) return existing;

	if (!isConfigured()) {
		throw new Error(
			'[opencode-sdk] No auth token provider configured — call configureKortix()/createKortix() before talking to a sandbox runtime.',
		);
	}

	const client = createOpencodeClient({ baseUrl: url, fetch: authenticatedFetch as typeof fetch });
	clientsByUrl.set(url, client);
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
const publicClientsByUrl = new Map<string, OpencodeClient>();

/**
 * Get (or create) a PUBLIC, unauthenticated client bound to a specific base
 * URL. See the {@link publicClientsByUrl} comment for why this exists as a
 * deliberate, separate cache/factory rather than a flag on `getClientForUrl`.
 */
export function getPublicClientForUrl(url: string): OpencodeClient {
	if (!url) {
		throw new Error('[opencode-sdk] getPublicClientForUrl called without a url');
	}
	const existing = publicClientsByUrl.get(url);
	if (existing) return existing;

	const client = createOpencodeClient({ baseUrl: url, fetch });
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
 * Reload the in-sandbox Kortix services daemon (opencode + its plugins).
 * `'dispose-only'` tears down and re-creates config without a full process
 * restart; `'full'` restarts the whole daemon process. Hits the active
 * runtime's `POST /kortix/services/system/reload` — same auth path as every
 * other sandbox call (`authenticatedFetch` via the active server URL).
 */
export async function systemReload(mode: SystemReloadMode): Promise<SystemReloadResult> {
	const url = getActiveOpenCodeUrl();
	if (!url) {
		throw new ApiError('[opencode-sdk] Server URL not ready — sandbox is still loading', {
			code: 'RUNTIME_UNAVAILABLE',
		});
	}
	const response = await authenticatedFetch(`${url}/kortix/services/system/reload`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ mode }),
	});
	if (!response.ok) {
		throw new ApiError(`System reload failed (${response.status}): ${await daemonErrorMessage(response)}`, {
			status: response.status,
			response,
			code: 'RUNTIME_UNAVAILABLE',
		});
	}
	return response.json() as Promise<SystemReloadResult>;
}
