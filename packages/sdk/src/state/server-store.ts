import { create } from 'zustand';

import { platformConfig } from '../platform/config';

import { type ServerStore } from './server-store/types';
import {
  getBackendUrl,
  getDefaultSandboxUrl,
} from './server-store/url-helpers';
import {
  getCurrentRuntimeSandboxId,
  getCurrentRuntimeUrl,
  getCurrentRuntimeDbSandboxId,
} from './current-runtime';

// Re-export the public surface that lives in sibling modules so importers of
// '../state/server-store' (and '@kortix/sdk/server-store') stay unchanged.
export { getSandboxUrlForExternalId } from './server-store/url-helpers';

/**
 * server-store — a thin, read-only view over the per-session runtime.
 *
 * The runtime (which sandbox the app talks to) is owned by `current-runtime`,
 * set by the active session via `useSession`. This store exposes it as a stable
 * surface: `getActiveServerUrl()` resolves the active OpenCode proxy URL. The
 * old multi-instance registry, the persisted server list, and the server-
 * switching machinery are gone — there is no "active server" to switch.
 */
export const useServerStore = create<ServerStore>(() => ({
  getActiveServerUrl: () => getActiveOpenCodeUrl(),
}));

/**
 * Resolve the active OpenCode proxy URL (routed through the backend).
 * Prefers the per-session runtime; falls back to the local-dev default sandbox.
 * Use in non-React contexts (API modules, etc.).
 */
export function getActiveOpenCodeUrl(): string {
  const current = getCurrentRuntimeUrl();
  if (current) return current;
  // Cloud/billing deployments have no local default — wait for the session to
  // point the runtime at its sandbox ('' tells callers to skip/retry).
  if (platformConfig().billingEnabled ?? false) return '';
  // Self-hosted local dev: talk to the default container sandbox.
  return getDefaultSandboxUrl();
}

/**
 * sandboxId for the active runtime.
 * - With an active session: the session's sandbox external id (current-runtime).
 * - Otherwise: the configured default sandbox id (self-hosted local dev).
 */
export function getActiveSandboxId(): string | undefined {
  return getCurrentRuntimeSandboxId() ?? platformConfig().sandboxId ?? undefined;
}

/**
 * DB instance id (platform `sandbox_id`) for the active runtime's sandbox.
 *
 * This is the stable DB primary key — distinct from the external id returned by
 * `getActiveSandboxId()`. Ownership-scoped APIs (per-sandbox API keys) key on
 * this, not the external id (which the backend would mistake for the DB key).
 * Only set while a session runtime is active.
 */
export function getActiveDbSandboxId(): string | undefined {
  return getCurrentRuntimeDbSandboxId() ?? undefined;
}

/**
 * Extract the backend port from NEXT_PUBLIC_BACKEND_URL (e.g. 8008 from
 * "http://localhost:8008/v1"). Used for subdomain URL construction:
 *   http://p{port}-{sandboxId}.localhost:{backendPort}/
 */
export function getBackendPort(): number {
  try {
    const url = new URL(getBackendUrl());
    return parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);
  } catch {
    return 8008; // fallback for local dev
  }
}

/**
 * Subdomain URL options for the active runtime (pure-ish function).
 *
 * Always returns a valid options object — never undefined. Every provider routes
 * through the same backend preview proxy; the `apiBaseUrl` field lets
 * `rewriteLocalhostUrl` take the path-based branch on VPS/cloud deployments
 * where *.localhost DNS isn't available. The sandbox id comes from the active
 * runtime (no legacy 'kortix-sandbox' default — it masked the real cloud sandbox
 * and 403'd the preview proxy).
 */
export function deriveSubdomainOpts(): { sandboxId: string; backendPort: number; apiBaseUrl: string } {
  return {
    sandboxId: getActiveSandboxId() || '',
    backendPort: getBackendPort(),
    apiBaseUrl: getBackendUrl(),
  };
}
