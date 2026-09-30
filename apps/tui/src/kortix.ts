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

/** Build the client for `resolved` and make it this process's client. */
export function initKortix(resolved: ResolvedHost): Kortix {
  client = createKortix({
    backendUrl: resolved.backendUrl,
    getToken: async () => resolved.token || null,
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
