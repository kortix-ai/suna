import { platformConfig } from '../../http/config';
import {
  getCurrentRuntimeDbSandboxId,
  getCurrentRuntimeSandboxId,
  getCurrentRuntimeUrl,
} from '../current-runtime';
import { getBackendUrl, getDefaultSandboxUrl } from './url-helpers';

/**
 * Active-runtime resolution, framework-free. These are the read helpers the
 * isomorphic core (`createKortix`, the opencode client factory) resolves the
 * runtime through; the zustand read surface in `../server-store` layers on top
 * for React hosts.
 */

/**
 * Resolve the active Runtime proxy URL (routed through the backend).
 * Prefers the per-session runtime; falls back to the local-dev default sandbox.
 * Use in non-React contexts (API modules, etc.).
 */
export function getActiveRuntimeUrl(): string {
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
    return Number.parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);
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
export function deriveSubdomainOpts(): {
  sandboxId: string;
  backendPort: number;
  apiBaseUrl: string;
} {
  return {
    sandboxId: getActiveSandboxId() || '',
    backendPort: getBackendPort(),
    apiBaseUrl: getBackendUrl(),
  };
}
