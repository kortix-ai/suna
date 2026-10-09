/**
 * How Kortix reaches a backend machine's ports: a PRIVATE Platinum exposure.
 *
 * Platinum's edge refuses a request to a private port without the HMAC preview
 * token, so the machine's own hostname (`https://<port>-<id>.<region>.sbx…`)
 * grants nothing. Kortix holds the token and is the only caller: the API
 * itself (health, admin key, environment) and the public proxy on the Kortix
 * hostnames (./hosts.ts). This is the same ingress session sandboxes and Apps
 * use (PlatinumProvider.resolveIngress), cached per port for five minutes;
 * the token lives a day. Resolving a port also turns every port the machine
 * still exposes publicly into a private one.
 */
import { ingressTargetUrl } from '../../../platform/providers/ingress-url';
import type { ResolvedSandboxIngress } from '../../../platform/providers';
import { invalidatePreviewLink, resolveSandboxIngress } from '../../../sandbox-proxy/backend';

export const BACKEND_MACHINE_PROVIDER = 'platinum';

/** One cached ingress per port serves HTTP and WebSocket alike: Platinum's edge takes the same token for both. */
export function backendIngress(externalId: string, port: number): Promise<ResolvedSandboxIngress> {
  return resolveSandboxIngress({ externalId, provider: BACKEND_MACHINE_PROVIDER }, { port, transport: 'http' });
}

/** Drops the cached ingress of one port: the next call exposes it again and gets a fresh token. */
export function forgetBackendIngress(externalId: string, port: number): void {
  invalidatePreviewLink(externalId, port);
}

/** `fetch` against one port of the machine, through its private exposure. */
export async function machineFetch(externalId: string, port: number, pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  const ingress = await backendIngress(externalId, port);
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(ingress.headers)) headers.set(name, value);
  try {
    return await fetch(ingressTargetUrl(ingress, pathAndQuery), { ...init, headers });
  } catch (error) {
    forgetBackendIngress(externalId, port);
    throw error;
  }
}
