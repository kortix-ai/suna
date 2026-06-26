import { platformConfig } from '../../platform/config';
import {
  DEFAULT_SERVER_ID,
  PATH_PROXY_URL_REGEX,
  type ServerEntry,
} from './types';

/**
 * The default sandbox URL routes through the backend's unified preview proxy.
 * Uses the container name ('kortix-sandbox') as the sandbox ID — the backend
 * resolves this via Docker DNS on the shared network.
 * Same URL pattern for all providers: /v1/p/{sandboxId}/{port}/*
 */
export function getBackendUrl(): string {
  return (platformConfig().backendUrl || 'http://localhost:8008/v1').replace(/\/+$/, '');
}

export function getDefaultSandboxUrl(): string {
  const sandboxId = platformConfig().sandboxId || 'kortix-sandbox';
  return `${getBackendUrl()}/p/${sandboxId}/8000`;
}

export function getServersApi(): string {
  return `${getBackendUrl()}/servers`;
}

/**
 * Derive the proxy URL for a managed sandbox entry.
 * Always computed fresh — never persisted — so route renames can't go stale.
 */
export function getSandboxServerUrl(sandboxId: string): string {
  return `${getBackendUrl()}/p/${sandboxId}/8000`;
}

/**
 * Resolve the effective URL for any server entry.
 * Sandbox entries store url='' — their URL is derived from sandboxId.
 * Custom entries use the user-provided URL directly.
 */
export function resolveServerUrl(server: ServerEntry): string {
  if (server.sandboxId) return getSandboxServerUrl(server.sandboxId);
  return server.url || getDefaultSandboxUrl();
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

export function deriveProxyBaseFromServerUrl(url: string): { sandboxId: string; backendPort: number; apiBaseUrl: string } | null {
  try {
    const parsed = new URL(url);
    const subdomainMatch = parsed.hostname.match(/^p(\d+)-([^.]+)\.localhost$/);
    if (subdomainMatch) {
      const backendPort = parseInt(parsed.port, 10) || (parsed.protocol === 'https:' ? 443 : 80);
      return {
        sandboxId: subdomainMatch[2],
        backendPort,
        apiBaseUrl: `http://localhost:${backendPort}/v1`,
      };
    }

    const pathMatch = url.match(PATH_PROXY_URL_REGEX);
    if (pathMatch) {
      return {
        sandboxId: pathMatch[1],
        backendPort: parseInt(parsed.port, 10) || (parsed.protocol === 'https:' ? 443 : 80),
        apiBaseUrl: `${parsed.protocol}//${parsed.host}/v1`,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export function generateId(): string {
  return `srv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const createDefaultServer = (): ServerEntry => ({
  id: DEFAULT_SERVER_ID,
  label: 'Local Sandbox',
  url: getDefaultSandboxUrl(),
  isDefault: true,
  provider: 'local_docker',
});
