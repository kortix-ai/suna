/**
 * The daemon transport for the sandbox env sync: the HTTP POST to
 * `/kortix/env`, its URL-security policy and its error class. Split out of
 * `sandbox-env-push.ts` (KRTX-1499), which keeps the memo/skip machinery.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateIp } from '../../shared/ssrf-guard';
import { SECRET_CAPABILITIES_ENV_NAME } from '../secret-capabilities';
import type { SandboxEnvSnapshot } from './sandbox-env-snapshot';

export const SANDBOX_SERVICE_PORT = 8000;
const ENV_PUSH_TIMEOUT_MS = 15_000;

async function isSecureOrPrivateTarget(rawUrl: string): Promise<boolean> {
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
  if (!h.includes('.')) return true; // single-label docker/service name on a private bridge
  if (/\.(local|internal|svc|cluster\.local)$/.test(h)) return true;
  // RFC1918 / link-local — anchored to full IPv4 literals so a public hostname
  // like "10.foo.evil.com" can't slip through a `^10.` prefix match.
  if (/^10(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^192\.168(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^169\.254(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // IPv6 unique-local
  // Any other name is private only if it RESOLVES privately: a provider edge on
  // a wildcard-DNS name for a loopback or tailnet address (`*.127.0.0.1.nip.io`)
  // is as local as `localhost`. Every address must be non-public.
  if (isIP(h) !== 0) return false;
  try {
    const resolved = await dnsLookup(h, { all: true });
    // Plain http to a public host: refuse to send secrets in cleartext.
    return resolved.length > 0 && resolved.every((r) => isPrivateIp(r.address));
  } catch {
    return false;
  }
}

/** The daemon answered the env push with a non-2xx. */
export class EnvSyncHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`env sync failed: ${status}${body ? ` ${body.slice(0, 500)}` : ''}`);
    this.name = 'EnvSyncHttpError';
  }
}

export async function postEnvToDaemon(args: {
  previewUrl: string;
  providerHeaders: Record<string, string>;
  serviceKey: string;
  snapshot: SandboxEnvSnapshot;
  refreshModels?: boolean;
  /** Runtime env the daemon applies to the OPENCODE process (allow-listed there). */
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
  /**
   * How the daemon applied the config, or null when it did not say (an older
   * daemon, or no reload was needed). 'kept-old' is the verified swap
   * declining: the new opencode never came up and the previous one still
   * serves — the push landed, the config did not.
   */
  opencodeReload: 'disposed' | 'restarted' | 'kept-old' | null;
  /**
   * Did applying the config interrupt a turn someone was waiting on?
   * `null` = the box did not say (older daemon, or no reload happened).
   */
  opencodeTurnEnded: boolean | null;
}> {
  if (!(await isSecureOrPrivateTarget(args.previewUrl))) {
    throw new Error('refusing to push secrets over insecure transport (non-TLS public host)');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${args.serviceKey}`,
    ...args.providerHeaders,
  };

  const runtimeEnv = {
    ...(args.opencodeEnv ?? {}),
    [SECRET_CAPABILITIES_ENV_NAME]: args.snapshot.capabilitiesJson,
  };
  const res = await fetch(`${args.previewUrl.replace(/\/$/, '')}/kortix/env`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      env: args.snapshot.env,
      names: args.snapshot.names,
      revision: args.snapshot.revision,
      refreshModels: args.refreshModels ?? false,
      runtimeEnv,
      // The same map under its pre-W3 name, for a daemon built before W3.
      opencodeEnv: runtimeEnv,
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
    throw new EnvSyncHttpError(res.status, body);
  }
  // The daemon echoes opencode's post-sync state. After a model-affecting change
  // it restarts opencode and reports `starting` here — the signal we use to wait
  // for readiness before the prompt is forwarded.
  const body = (await res.json().catch(() => null)) as {
    ok?: unknown;
    revision?: unknown;
    exported?: unknown;
    managed?: unknown;
    withheld?: unknown;
    agent_env_written?: unknown;
    runtime?: unknown;
    runtime_reload?: unknown;
    runtime_turn_ended?: unknown;
    /** Pre-W3 names of the three fields above; a daemon built before W3 sends only these. */
    opencode?: unknown;
    opencode_reload?: unknown;
    opencode_turn_ended?: unknown;
  } | null;
  const runtimeState = body?.runtime ?? body?.opencode;
  const runtimeReload = body?.runtime_reload ?? body?.opencode_reload;
  const runtimeTurnEnded = body?.runtime_turn_ended ?? body?.opencode_turn_ended;
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
    opencodeState: typeof runtimeState === 'string' ? runtimeState : null,
    // How the daemon applied the config. 'kept-old' means the verified swap
    // declined: the new opencode never came up, so the running one still
    // serves and the change did NOT take. An older daemon omits the field
    // entirely — null, meaning "could not tell", never "it worked".
    opencodeReload:
      typeof runtimeReload === 'string' ? (runtimeReload as 'disposed' | 'restarted' | 'kept-old') : null,
    opencodeTurnEnded: typeof runtimeTurnEnded === 'boolean' ? runtimeTurnEnded : null,
    revision: typeof body?.revision === 'string' ? body.revision : args.snapshot.revision,
    exported: typeof body?.exported === 'number' ? body.exported : expectedExported,
    managed: typeof body?.managed === 'number' ? body.managed : null,
    withheld: typeof body?.withheld === 'number' ? body.withheld : null,
    agentEnvWritten: body?.agent_env_written === true,
  };
}
