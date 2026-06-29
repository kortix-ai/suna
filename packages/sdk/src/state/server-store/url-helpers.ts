import { platformConfig } from '../../platform/config';

/**
 * The backend base URL. All sandbox traffic routes through the backend's
 * unified preview proxy: /v1/p/{sandboxId}/{port}/*
 */
export function getBackendUrl(): string {
  return (platformConfig().backendUrl || 'http://localhost:8008/v1').replace(/\/+$/, '');
}

export function getDefaultSandboxUrl(): string {
  // Self-host override only; empty in cloud (the session runtime is the source
  // of truth). No auto-default — an unconfigured id just yields an empty path.
  const sandboxId = platformConfig().sandboxId || '';
  return `${getBackendUrl()}/p/${sandboxId}/8000`;
}

/**
 * Derive the proxy URL for a managed sandbox by its provider sandbox id.
 * Always computed fresh — never persisted — so route renames can't go stale.
 */
export function getSandboxServerUrl(sandboxId: string): string {
  return `${getBackendUrl()}/p/${sandboxId}/8000`;
}

/**
 * Derive the OpenCode proxy URL for a sandbox by its provider sandbox id
 * (a project session's `external_id`). Pure function of the id — no dependency
 * on the active server — so we can connect to several session sandboxes in
 * parallel (e.g. background SSE streams for every open session tab).
 */
export function getSandboxUrlForExternalId(externalId: string): string {
  return getSandboxServerUrl(externalId);
}

