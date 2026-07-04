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

// Sandbox env/secrets client (`GET/PUT/DELETE /env`) and the `/kortix/triggers`
// wrapper both live in sibling modules, re-exported here so hosts only ever
// import daemon operations from this one subpath.
export { listEnv, setEnv, deleteEnv, env } from "./env";
export { triggersRequest } from "./triggers";


/**
 * Per-URL client cache. Unlike `getClient()` (which tracks only the single
 * active server), this keeps one client alive PER sandbox URL so we can talk to
 * several session sandboxes in parallel — every open session stays connected to
 * its own runtime at the same time. Keyed by absolute base URL.
 */
const clientsByUrl = new Map<string, OpencodeClient>();

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
		throw new Error('[opencode-sdk] Server URL not ready — sandbox is still loading');
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
		throw new Error('[opencode-sdk] Server URL not ready — sandbox is still loading');
	}
	const response = await authenticatedFetch(`${url}/kortix/services/system/reload`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ mode }),
	});
	if (!response.ok) {
		throw new Error(`System reload failed (${response.status}): ${await daemonErrorMessage(response)}`);
	}
	return response.json() as Promise<SystemReloadResult>;
}
