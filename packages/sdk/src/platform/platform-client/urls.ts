/**
 * Platform API client — sandbox URL and port helpers.
 */

import { SANDBOX_PORTS, type SandboxInfo } from './types';
import { getPlatformUrl } from './shared';

/**
 * Build the OpenCode server URL for a sandbox.
 * Provider-agnostic: {BACKEND_URL}/p/{externalId}/8000
 *
 * The external_id is the sandbox's Daytona ID, used for proxy routing.
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
