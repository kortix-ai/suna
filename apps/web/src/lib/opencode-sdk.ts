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
import { authenticatedFetch } from "@/lib/auth-token";
import { getEnv } from "@/lib/env-config";
import { getActiveOpenCodeUrl, registerClientResetter } from "@/stores/server-store";

let cachedClient: OpencodeClient | null = null;
let cachedUrl: string | null = null;

function shouldUsePlatformAuth(baseUrl: string): boolean {
	try {
		const target = new URL(baseUrl);
		const backend = new URL(getEnv().BACKEND_URL);
		const backendPath = backend.pathname.replace(/\/+$/, "");
		return target.origin === backend.origin &&
			(target.pathname === backendPath || target.pathname.startsWith(`${backendPath}/`));
	} catch {
		return false;
	}
}

// Register the reset function so server-store can call it without a circular import
registerClientResetter(resetClient);

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
	if (cachedClient && cachedUrl === url) return cachedClient;

	const fetchImpl = shouldUsePlatformAuth(url)
		? authenticatedFetch as typeof fetch
		: ((input, init) => fetch(input, init)) as typeof fetch;

	cachedClient = createOpencodeClient({
		baseUrl: url,
		fetch: fetchImpl,
	});
	cachedUrl = url;
	return cachedClient;
}

/**
 * Force-recreate the client (e.g. after a server switch or token change).
 */
export function resetClient(): void {
	cachedClient = null;
	cachedUrl = null;
}
