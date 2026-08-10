import {
  buildSandboxUpstreamHeaders,
  resolveSandboxIngress,
  resolveServiceKey,
} from '../sandbox-proxy/backend';

const DAEMON_PORT = 8000;

export type SandboxRuntimeHealth = {
  runtimeReady: boolean;
  bootError: string | null;
};

export function parseSandboxRuntimeHealth(body: Record<string, unknown>): SandboxRuntimeHealth {
  return {
    runtimeReady: body.runtimeReady === true,
    bootError: typeof body.boot_error === 'string' ? body.boot_error : null,
  };
}

export async function inspectSandboxRuntime(
  externalId: string,
  userId: string | undefined,
): Promise<SandboxRuntimeHealth | null> {
  try {
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
    const response = await fetch(`${ingress.url.replace(/\/$/, '')}/kortix/health`, {
      headers,
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    return parseSandboxRuntimeHealth(
      (await response.json()) as Record<string, unknown>,
    );
  } catch {
    return null;
  }
}
