import { SECRET_CAPABILITIES_ENV_NAME } from '../secret-capabilities';
import type { SandboxEnvSnapshot } from './snapshot';

export const SANDBOX_SERVICE_PORT = 8000;
const ENV_PUSH_TIMEOUT_MS = 15_000;

function isSecureOrPrivateTarget(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const h = u.hostname;
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(h)) return true;
  if (!h.includes('.')) return true;
  if (/\.(local|internal|svc|cluster\.local)$/.test(h)) return true;
  if (/^10(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^192\.168(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^169\.254(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
  return false;
}

export async function postEnvToDaemon(args: {
  previewUrl: string;
  providerHeaders: Record<string, string>;
  serviceKey: string;
  snapshot: SandboxEnvSnapshot;
  refreshModels?: boolean;
  opencodeEnv?: Record<string, string | null>;
  llmGatewayEnabled?: boolean;
  llmGatewayBaseUrl?: string;
  requireAgentEnvProof?: boolean;
}): Promise<{
  opencodeState: string | null;
  revision: string;
  exported: number;
  managed: number | null;
  withheld: number | null;
  agentEnvWritten: boolean;
  opencodeReload: 'disposed' | 'restarted' | 'kept-old' | null;
  opencodeTurnEnded: boolean | null;
}> {
  if (!isSecureOrPrivateTarget(args.previewUrl)) {
    throw new Error('refusing to push secrets over insecure transport (non-TLS public host)');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${args.serviceKey}`,
    ...args.providerHeaders,
  };
  const res = await fetch(`${args.previewUrl.replace(/\/$/, '')}/kortix/env`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      env: args.snapshot.env,
      names: args.snapshot.names,
      revision: args.snapshot.revision,
      refreshModels: args.refreshModels ?? false,
      opencodeEnv: {
        ...(args.opencodeEnv ?? {}),
        [SECRET_CAPABILITIES_ENV_NAME]: args.snapshot.capabilitiesJson,
      },
      ...(typeof args.llmGatewayEnabled === 'boolean'
        ? {
            llmGatewayEnabled: args.llmGatewayEnabled,
            ...(args.llmGatewayBaseUrl ? { llmGatewayBaseUrl: args.llmGatewayBaseUrl } : {}),
          }
        : {}),
    }),
    signal: AbortSignal.timeout(ENV_PUSH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`env sync failed: ${res.status}${body ? ` ${body.slice(0, 500)}` : ''}`);
  }
  const body = (await res.json().catch(() => null)) as {
    ok?: unknown;
    revision?: unknown;
    exported?: unknown;
    managed?: unknown;
    withheld?: unknown;
    agent_env_written?: unknown;
    opencode?: unknown;
    opencode_reload?: unknown;
    opencode_turn_ended?: unknown;
  } | null;
  const expectedExported = Object.keys(args.snapshot.env).length;
  if (args.requireAgentEnvProof) {
    if (!body || body.ok !== true) throw new Error('env sync proof missing ok=true');
    if (body.revision !== args.snapshot.revision) {
      throw new Error(`env sync revision mismatch: expected ${args.snapshot.revision}, received ${String(body.revision)}`);
    }
    if (body.agent_env_written !== true) {
      throw new Error('env sync did not confirm agent-env.sh write');
    }
    if (body.exported !== expectedExported) {
      throw new Error(`env sync export mismatch: expected ${expectedExported}, received ${String(body.exported)}`);
    }
  }
  return {
    opencodeState: typeof body?.opencode === 'string' ? body.opencode : null,
    opencodeReload: typeof body?.opencode_reload === 'string'
      ? body.opencode_reload as 'disposed' | 'restarted' | 'kept-old' : null,
    opencodeTurnEnded: typeof body?.opencode_turn_ended === 'boolean' ? body.opencode_turn_ended : null,
    revision: typeof body?.revision === 'string' ? body.revision : args.snapshot.revision,
    exported: typeof body?.exported === 'number' ? body.exported : expectedExported,
    managed: typeof body?.managed === 'number' ? body.managed : null,
    withheld: typeof body?.withheld === 'number' ? body.withheld : null,
    agentEnvWritten: body?.agent_env_written === true,
  };
}
