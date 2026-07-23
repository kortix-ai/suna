import { HARNESS_IDS, type HarnessId } from '@kortix/shared/harnesses';

import {
  buildSandboxUpstreamHeaders,
  resolveSandboxIngress,
  resolveServiceKey,
} from '../sandbox-proxy/backend';

const DAEMON_PORT = 8000;

export type SandboxRuntimeHealth = {
  runtime: 'acp' | 'legacy';
  runtimeReady: boolean;
  acpServerId: string | null;
  acpHarness: HarnessId | null;
  bootError: string | null;
};

export async function sandboxRuntimeEndpoint(
  externalId: string,
  userId: string | undefined,
): Promise<{
  url: string;
  headers: Record<string, string>;
  serviceKey: string;
} | null> {
  const serviceKey = await resolveServiceKey(externalId);
  if (!serviceKey) return null;
  const ingress = await resolveSandboxIngress(externalId, { port: DAEMON_PORT });
  const headers = await buildSandboxUpstreamHeaders({
    sandboxId: externalId,
    userId: userId ?? '',
    serviceKey,
    providerHeaders: ingress.headers,
  });
  headers['Content-Type'] = 'application/json';
  return {
    url: ingress.url.replace(/\/$/, ''),
    headers,
    serviceKey,
  };
}

export async function inspectSandboxRuntime(
  externalId: string,
  userId: string | undefined,
): Promise<SandboxRuntimeHealth | null> {
  try {
    const endpoint = await sandboxRuntimeEndpoint(externalId, userId);
    if (!endpoint) return null;
    const response = await fetch(`${endpoint.url}/kortix/health`, {
      headers: endpoint.headers,
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const harness = (HARNESS_IDS as readonly string[]).includes(String(body.acp_harness))
      ? body.acp_harness as SandboxRuntimeHealth['acpHarness']
      : null;
    return {
      runtime: body.runtime === 'acp' ? 'acp' : 'legacy',
      runtimeReady: body.runtimeReady === true,
      acpServerId: typeof body.acp_server_id === 'string' ? body.acp_server_id : null,
      acpHarness: harness,
      bootError: typeof body.boot_error === 'string' ? body.boot_error : null,
    };
  } catch {
    return null;
  }
}
