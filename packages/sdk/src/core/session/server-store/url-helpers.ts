import { platformConfig } from '../../http/config';

// Linear trailing-slash strip — the regex form (/\/+$/) backtracks
// quadratically on adversarial input (CodeQL js/polynomial-redos).
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return s.slice(0, end);
}

/**
 * The backend base URL. All sandbox traffic routes through the backend's
 * unified preview proxy: /v1/p/{sandboxId}/{port}/*
 */
export function getBackendUrl(): string {
  return stripTrailingSlashes(platformConfig().backendUrl || 'http://localhost:8008/v1');
}

export function getDefaultSandboxUrl(): string {
  // Self-host override only; empty in cloud (the session runtime is the source
  // of truth). No auto-default — an unconfigured id just yields an empty path.
  const sandboxId = platformConfig().sandboxId || '';
  return `${getBackendUrl()}/p/${sandboxId}/8000`;
}

/**
 * Derive the proxy URL for a cloud sandbox by its provider sandbox id.
 * Always computed fresh — never persisted — so route renames can't go stale.
 */
export function getSandboxServerUrl(sandboxId: string): string {
  return `${getBackendUrl()}/p/${sandboxId}/8000`;
}

/**
 * Derive the Runtime proxy URL for a sandbox by its provider sandbox id
 * (a project session's `external_id`). Pure function of the id — no dependency
 * on the active server — so we can connect to several session sandboxes in
 * parallel (e.g. background SSE streams for every open session tab).
 */
export function getSandboxUrlForExternalId(externalId: string): string {
  return getSandboxServerUrl(externalId);
}

/**
 * Derive the base URL for the backend's UNAUTHENTICATED public-share proxy
 * (`/v1/p/public-share/{token}/{port}` — see
 * `apps/api/src/sandbox-proxy/routes/public-share.ts`), mirroring how
 * {@link getSandboxUrlForExternalId} derives the authenticated
 * `/v1/p/{externalId}/{port}` route. Pure function of the token — no
 * dependency on the active server.
 *
 * The backend blocks the runtime API port (8000) on this route
 * (`PUBLIC_SHARE_BLOCKED_PORTS` in `apps/api/src/shared/session-public-shares.ts`)
 * — this only ever reaches a shared preview port or the file share, never a
 * session's runtime control API.
 */
export function getPublicShareUrlForToken(token: string, port: number): string {
  return `${getBackendUrl()}/p/public-share/${token}/${port}`;
}
