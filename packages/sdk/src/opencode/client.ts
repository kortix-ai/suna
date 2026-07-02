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
// imports `Event`, `Part`, `Message`, `Session`, `Pty`, `Config`, … from
// `@kortix/sdk/opencode-client` and NEVER from `@opencode-ai/sdk` directly. This
// also pins everyone to the SDK's single opencode-sdk version (kills the
// 1.17.9-vs-1.14.28 type skew). The SDK is the sole owner of that dependency.
export type * from "@opencode-ai/sdk/v2/client";
export type { OpencodeClient };

import { authenticatedFetch } from "../platform/auth";
import { platformConfig } from "../platform/config";
import { getActiveOpenCodeUrl } from "../state/server-store/active";


/**
 * Resolve the backend base URL as an ABSOLUTE URL.
 *
 * `getEnv().BACKEND_URL` may be root-relative (e.g. "/v1") in the sandbox
 * preview, where the browser deliberately hits the same origin. Server-side
 * (SSR), prefer the absolute `process.env.BACKEND_URL` so `new URL(...)` has a
 * valid base; in the browser, fall back to resolving the relative value against
 * the current origin. Mirrors the pattern in platform-client.ts.
 */
function getAbsoluteBackendUrl(): string {
	if (typeof process !== "undefined" && process.env?.BACKEND_URL) {
		return process.env.BACKEND_URL;
	}
	const value = platformConfig().backendUrl;
	if (value.startsWith("/") && typeof window !== "undefined") {
		return new URL(value, window.location.origin).toString();
	}
	return value;
}

/**
 * Per-URL client cache. Unlike `getClient()` (which tracks only the single
 * active server), this keeps one client alive PER sandbox URL so we can talk to
 * several session sandboxes in parallel — every open session stays connected to
 * its own runtime at the same time. Keyed by absolute base URL.
 */
const clientsByUrl = new Map<string, OpencodeClient>();

function shouldUsePlatformAuth(baseUrl: string): boolean {
	try {
		const target = new URL(baseUrl);
		const backend = new URL(getAbsoluteBackendUrl());
		const backendPath = backend.pathname.replace(/\/+$/, "");
		return target.origin === backend.origin &&
			(target.pathname === backendPath || target.pathname.startsWith(`${backendPath}/`));
	} catch {
		return false;
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
 */
export function getClientForUrl(url: string): OpencodeClient {
	if (!url) {
		throw new Error('[opencode-sdk] getClientForUrl called without a url');
	}
	const existing = clientsByUrl.get(url);
	if (existing) return existing;

	const fetchImpl = shouldUsePlatformAuth(url)
		? (authenticatedFetch as typeof fetch)
		: (((input, init) => fetch(input, init)) as typeof fetch);

	const client = createOpencodeClient({ baseUrl: url, fetch: fetchImpl });
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
