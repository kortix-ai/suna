import { platformConfig } from '../../http/config';
import {
  getCurrentRuntimeDbSandboxId,
  getCurrentRuntimeSandboxId,
  getCurrentRuntimeUrl,
  getCurrentWorkspaceRuntimeSandboxId,
  getCurrentWorkspaceRuntimeUrl,
  currentRuntimeStore,
} from '../current-runtime';
import { getBackendUrl, getDefaultSandboxUrl } from './url-helpers';
import { resolvePreviewOptions, type ResolvedPreviewOptions } from '../preview-options';

/**
 * Active-runtime resolution, framework-free. These are the read helpers the
 * isomorphic core (`createKortix`, the opencode client factory) resolves the
 * runtime through; the zustand read surface in `../server-store` layers on top
 * for React hosts.
 */

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

/** Resolve the runtime that owns files, PTYs, and user-exposed ports. */
export function getActiveWorkspaceUrl(): string {
  const workspace = getCurrentWorkspaceRuntimeUrl();
  if (workspace) return workspace;
  if (currentRuntimeStore.getState().dataRuntimeKind === 'environment') return '';
  return getActiveOpenCodeUrl();
}

/**
 * sandboxId for the active runtime.
 * - With an active session: the session's sandbox external id (current-runtime).
 * - Otherwise: the configured default sandbox id (self-hosted local dev).
 */
export function getActiveSandboxId(): string | undefined {
  return getCurrentRuntimeSandboxId() ?? platformConfig().sandboxId ?? undefined;
}

/** Provider id for files, PTYs, and preview ports. */
export function getActiveWorkspaceSandboxId(): string | undefined {
  const workspace = getCurrentWorkspaceRuntimeSandboxId();
  if (workspace) return workspace;
  if (currentRuntimeStore.getState().dataRuntimeKind === 'environment') return undefined;
  return getActiveSandboxId();
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
 * Preview URL options for the ACTIVE runtime — the ambient path, used where no
 * session handle is in scope: `useSandboxProxy`, `proxySandboxUrl`,
 * `buildStaticFilePreviewUrl`, the session panel's app-preview iframe.
 *
 * A thin binding of the active sandbox id to `resolvePreviewOptions`, which is
 * the single producer of a complete options bag. It deliberately assembles
 * nothing itself: this function once did, and quietly omitted
 * `previewUrlTemplate`, which made every ambient preview fall back to the path
 * proxy. See preview-options.ts.
 */
export function deriveSubdomainOpts(): ResolvedPreviewOptions {
  return resolvePreviewOptions({
    sandboxId: getActiveWorkspaceSandboxId() || '',
    backendPort: getBackendPort(),
    apiBaseUrl: getBackendUrl(),
  });
}
