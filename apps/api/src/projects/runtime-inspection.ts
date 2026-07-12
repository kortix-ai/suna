import { resolvePreviewLink, resolveServiceKey } from '../sandbox-proxy/backend';
import {
  KORTIX_USER_CONTEXT_HEADER,
  encodeKortixUserContext,
} from '../shared/kortix-user-context';
import { resolvePreviewUserContext } from '../shared/preview-ownership';

const DAEMON_PORT = 8000;

export type SandboxRuntimeHealth = {
  runtime: 'acp' | 'legacy';
  runtimeReady: boolean;
  acpServerId: string | null;
  acpHarness: 'claude' | 'codex' | 'opencode' | 'pi' | null;
  bootError: string | null;
};

export async function sandboxRuntimeEndpoint(
  externalId: string,
  userId: string | undefined,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  const serviceKey = await resolveServiceKey(externalId);
  if (!serviceKey) return null;
  const { url, token } = await resolvePreviewLink(externalId, DAEMON_PORT);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${serviceKey}`,
    'X-Daytona-Skip-Preview-Warning': 'true',
    'X-Daytona-Disable-CORS': 'true',
  };
  if (token) headers['X-Daytona-Preview-Token'] = token;
  const payload = await resolvePreviewUserContext(externalId, userId);
  if (payload) headers[KORTIX_USER_CONTEXT_HEADER] = encodeKortixUserContext(payload, serviceKey);
  return { url: url.replace(/\/$/, ''), headers };
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
    const harness = ['claude', 'codex', 'opencode', 'pi'].includes(String(body.acp_harness))
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
