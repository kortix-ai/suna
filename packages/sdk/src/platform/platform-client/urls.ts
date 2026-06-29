/**
 * Platform API client — sandbox URL and port helpers.
 */

import type { ServerEntry } from '../../state/server-store';
import { SANDBOX_PORTS, type SandboxInfo } from './types';
import { getPlatformUrl } from './shared';

/**
 * Get a URL to access a specific container port on a sandbox.
 * ALL modes route through the backend's unified preview proxy:
 *   {BACKEND_URL}/p/{sandboxId}/{containerPort}
 *
 * Provider-agnostic — sandboxId is the external_id (container name for local,
 * Daytona sandbox ID for cloud).
 */
export function getDirectPortUrl(
  server: ServerEntry,
  containerPort: string,
): string | null {
  if (server.sandboxId && server.sandboxId !== 'undefined') {
    return `${getPlatformUrl()}/p/${server.sandboxId}/${containerPort}`;
  }
  return null;
}

/**
 * Build the OpenCode server URL for a sandbox.
 * Provider-agnostic: {BACKEND_URL}/p/{externalId}/8000
 *
 * The external_id is the sandbox identifier used for routing:
 *   - Local Docker: container name (e.g. 'kortix-sandbox') — resolves via Docker DNS
 *   - Daytona (cloud): Daytona sandbox ID
 *
 * Guards against missing external_id to prevent broken URLs.
 */
export function getSandboxUrl(sandbox: SandboxInfo): string {
  if (!sandbox.external_id) {
    if (sandbox.base_url) return sandbox.base_url;
    throw new Error(
      `Cannot build sandbox URL: missing external_id for ${sandbox.provider} sandbox "${sandbox.sandbox_id}"`,
    );
  }

  return `${getPlatformUrl()}/p/${sandbox.external_id}/${SANDBOX_PORTS.KORTIX_MASTER}`;
}

/**
 * Build a URL to access a specific container port on a sandbox.
 * Provider-agnostic: {BACKEND_URL}/p/{externalId}/{containerPort}
 */
export function getSandboxPortUrl(
  sandbox: SandboxInfo,
  containerPort: string,
): string | null {
  if (sandbox.external_id) {
    return `${getPlatformUrl()}/p/${sandbox.external_id}/${containerPort}`;
  }
  return null;
}

/**
 * Extract mappedPorts from sandbox metadata (convenience for storing in ServerEntry).
 * Returns undefined if not available.
 */
// Container port→host-port mapping was a local_docker concept; cloud sandboxes
// route through the preview proxy, so there's nothing to extract.
export function extractMappedPorts(_sandbox: SandboxInfo): Record<string, string> | undefined {
  return undefined;
}
