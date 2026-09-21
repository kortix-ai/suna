/**
 * The one Kortix client for this process.
 *
 * CLAUDE.md: "One client per host. Create it once via `createKortix({
 * backendUrl, getToken })`." `createKortix` also installs the process-global
 * platform config every `@kortix/sdk/react` hook reads, so this module must be
 * initialized before the first hook renders — `src/main.tsx` does that at
 * boot, before `createRoot(...).render(<App/>)`.
 */

import { type Kortix, createKortix } from '@kortix/sdk';

import type { ResolvedHost } from './auth/hosts.ts';

let client: Kortix | null = null;
let host: ResolvedHost | null = null;

/**
 * Build the client for `resolved` and make it this process's client.
 *
 * `clientSource` identifies the surface in the backend's audit events. The
 * SDK's `KortixPlatformConfig.clientSource` union carries `'tui'` as of
 * `packages/sdk/src/core/http/config.ts:33` (and the `normalizeClientSource`
 * allowlist in `packages/sdk/src/platform/auth-core.ts`), so a TUI turn is
 * distinguishable from a CLI turn in
 * `kortix.session_audit_events.client_reported_source`.
 */
export function initKortix(resolved: ResolvedHost): Kortix {
  client = createKortix({
    backendUrl: resolved.backendUrl,
    getToken: async () => resolved.token || null,
    clientSource: 'tui',
  });
  host = resolved;
  return client;
}

/** The client. Throws when `initKortix` has not run — a boot-order bug. */
export function kortix(): Kortix {
  if (!client) throw new Error('kortix client not initialized: call initKortix() at boot');
  return client;
}

/** The host the client was built from, or null before boot. */
export function hostInfo(): ResolvedHost | null {
  return host;
}

/** Test seam: drop the client so a test can initialize a different host. */
export function resetKortixForTest(): void {
  client = null;
  host = null;
}
