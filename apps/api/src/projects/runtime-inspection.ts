import { isHarnessId, type HarnessId } from '@kortix/shared/harnesses';

import {
  buildSandboxUpstreamHeaders,
  resolveSandboxIngress,
  resolveServiceKey,
} from '../sandbox-proxy/backend';

const DAEMON_PORT = 8000;

export type SandboxRuntimeHealth = {
  runtime: 'acp' | 'opencode-rest';
  runtimeReady: boolean;
  acpServerId: string | null;
  runtimeHarness: HarnessId | null;
  bootError: string | null;
};

export type ManagedAcpSessionIdentity = {
  acpServerId: string;
  runtimeHarness: HarnessId;
};

export function readManagedAcpSessionIdentity(
  metadata: Record<string, unknown>,
): ManagedAcpSessionIdentity | null {
  if (
    metadata.runtime_transport !== 'acp' ||
    typeof metadata.acp_server_id !== 'string' ||
    !isHarnessId(metadata.runtime_harness)
  ) {
    return null;
  }
  return {
    acpServerId: metadata.acp_server_id,
    runtimeHarness: metadata.runtime_harness,
  };
}

export function parseSandboxRuntimeHealth(body: Record<string, unknown>): SandboxRuntimeHealth {
  const harnessValue = body.runtime_harness ?? body.acp_harness;
  const harness = isHarnessId(harnessValue) ? harnessValue : null;
  return {
    runtime: body.runtime === 'acp' ? 'acp' : 'opencode-rest',
    runtimeReady: body.runtimeReady === true,
    acpServerId: typeof body.acp_server_id === 'string' ? body.acp_server_id : null,
    runtimeHarness: harness,
    bootError: typeof body.boot_error === 'string' ? body.boot_error : null,
  };
}

export async function sandboxRuntimeEndpoint(
  externalId: string,
  userId: string | undefined,
): Promise<{
  url: string;
  headers: Record<string, string>;
  providerHeaders: Record<string, string>;
  serviceKey: string;
} | null> {
  const serviceKey = await resolveServiceKey(externalId);
  if (!serviceKey) return null;
  const ingress = await resolveSandboxIngress(externalId, {
    port: DAEMON_PORT,
    transport: 'http',
  });
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
    providerHeaders: ingress.headers,
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
    return parseSandboxRuntimeHealth(body);
  } catch {
    return null;
  }
}
