import { emitJson, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { loadAuth, loadAuthForHost } from '../api/auth.ts';
import { hasEnvTokenHost } from '../api/config.ts';
import { loadLink } from '../project-link.ts';
import { clientFromAuth, ApiError, type ApiClient } from '../api/client.ts';
import { C, pad, status } from '../style.ts';

// ── Shapes (mirror apps/api/src/tunnel) ──────────────────────────────────────

interface TunnelConnection {
  tunnelId: string;
  name: string;
  status: 'online' | 'offline' | 'connecting';
  capabilities: string[];
  machineInfo: Record<string, string> | null;
  lastHeartbeatAt: string | null;
  isLive: boolean;
  createdAt: string;
}

interface TunnelPermission {
  permissionId: string;
  capability: string;
  scope: Record<string, unknown>;
  status: 'active' | 'revoked' | 'expired';
  expiresAt: string | null;
}

const HELP = `Usage: kortix tunnel <subcommand> [options]

See and drive your fleet of registered computers over Agent Tunnel — a
permissioned reverse tunnel from cloud agents to a local machine (files,
shell, desktop). Connections are account-scoped (shared across your projects).

To connect a NEW computer, run this ON that machine:
  ${C.cyan}npx @kortix/agent-tunnel connect --api-url <api-base>/v1/tunnel${C.reset}

Subcommands:
  ls [--json]                        List registered computers + live status.
  show <tunnelId> [--json]           Show one computer + its granted permissions.
  rpc <tunnelId|--online> <method> [json] [--json]
                                     Relay a JSON-RPC to a computer (test/drive). e.g.
                                     kortix tunnel rpc --online shell.exec '{"command":"echo","args":["hi"]}'
  rm <tunnelId>                      Delete a connection (cascades permissions + audit).

Options:
  --host <name>    Use a specific logged-in host.
  --online         (rpc) target the first online computer instead of an id.
  --json           Machine-readable output (reads).
`;

// ── Auth (account-scoped — no linked project required) ───────────────────────

function resolveClient(hostArg?: string): ApiClient | null {
  let hostFromLink: string | undefined;
  if (!hostArg && !hasEnvTokenHost()) hostFromLink = loadLink()?.host ?? undefined;
  const hostName = hostArg ?? hostFromLink;
  const auth = hostName ? loadAuthForHost(hostName) : loadAuth();
  if (!auth?.token) {
    if (hostName) {
      process.stderr.write(
        `${status.err(`Host "${hostName}" is not logged in.`)} Run ` +
          `${C.cyan}kortix login --host ${hostName}${C.reset}.\n`,
      );
    } else {
      process.stderr.write(`${status.err('Not logged in. Run `kortix login`.')}\n`);
    }
    return null;
  }
  return clientFromAuth(auth);
}

// ── Formatting ───────────────────────────────────────────────────────────────

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function liveDot(conn: TunnelConnection): string {
  return conn.isLive ? `${C.green}●${C.reset}` : `${C.faded}○${C.reset}`;
}

function connectHint(): string {
  return (
    `${status.info('No computers connected yet.')}\n` +
    `     Run on the machine you want to connect:\n` +
    `       ${C.cyan}npx @kortix/agent-tunnel connect --api-url <api-base>/v1/tunnel${C.reset}\n`
  );
}

// ── Subcommands ──────────────────────────────────────────────────────────────

async function listConnections(client: ApiClient, json: boolean): Promise<number> {
  const conns = await client.get<TunnelConnection[]>('/tunnel/connections');
  if (json) {
    emitJson(conns);
    return 0;
  }
  if (!conns.length) {
    process.stdout.write(connectHint());
    return 0;
  }

  const online = conns.filter((c) => c.isLive).length;
  process.stdout.write(
    `\n  ${C.white}${C.bold}Computers${C.reset}  ${C.faded}${conns.length} total · ${online} online${C.reset}\n\n`,
  );
  for (const c of conns) {
    const host = c.machineInfo?.hostname ? `${C.faded}${c.machineInfo.hostname}${C.reset}` : `${C.faded}—${C.reset}`;
    const caps = c.capabilities.length ? c.capabilities.join(', ') : 'none';
    process.stdout.write(
      `  ${liveDot(c)} ${pad(`${C.bold}${c.name}${C.reset}`, 28)} ${pad(host, 28)} ` +
        `${C.faded}${c.isLive ? 'online' : `seen ${relTime(c.lastHeartbeatAt)}`}${C.reset}\n` +
        `    ${C.faded}${c.tunnelId}${C.reset}  ${C.dim}caps:${C.reset} ${caps}\n`,
    );
  }
  process.stdout.write('\n');
  return 0;
}

async function showConnection(client: ApiClient, tunnelId: string | undefined, json: boolean): Promise<number> {
  if (!tunnelId) {
    process.stderr.write(`${status.err('Usage: kortix tunnel show <tunnelId>')}\n`);
    return 2;
  }
  const conn = await client.get<TunnelConnection>(`/tunnel/connections/${tunnelId}`);
  const perms = await client.get<TunnelPermission[]>(`/tunnel/permissions/${tunnelId}`);
  if (json) {
    emitJson({ ...conn, permissions: perms });
    return 0;
  }

  process.stdout.write(
    `\n  ${liveDot(conn)} ${C.white}${C.bold}${conn.name}${C.reset}  ` +
      `${C.faded}${conn.isLive ? 'online' : `offline · seen ${relTime(conn.lastHeartbeatAt)}`}${C.reset}\n` +
      `    ${C.faded}${conn.tunnelId}${C.reset}\n`,
  );
  if (conn.machineInfo?.hostname) {
    const plat = conn.machineInfo.platform ? ` · ${conn.machineInfo.platform} ${conn.machineInfo.arch || ''}`.trimEnd() : '';
    process.stdout.write(`    ${C.dim}machine:${C.reset} ${conn.machineInfo.hostname}${plat}\n`);
  }
  process.stdout.write(`    ${C.dim}capabilities:${C.reset} ${conn.capabilities.length ? conn.capabilities.join(', ') : 'none'}\n`);

  const active = perms.filter((p) => p.status === 'active');
  process.stdout.write(`\n  ${C.white}Permissions${C.reset}  ${C.faded}${active.length} active${C.reset}\n`);
  if (!active.length) {
    process.stdout.write(`    ${C.faded}none granted — the agent must request access (you approve in the UI)${C.reset}\n\n`);
    return 0;
  }
  for (const p of active) {
    const exp = p.expiresAt ? `expires ${relTime(p.expiresAt).replace(' ago', '')}` : 'no expiry';
    process.stdout.write(
      `    ${C.green}●${C.reset} ${pad(p.capability, 12)} ${C.faded}${JSON.stringify(p.scope)}${C.reset} ${C.dim}(${exp})${C.reset}\n`,
    );
  }
  process.stdout.write('\n');
  return 0;
}

async function relayRpc(client: ApiClient, args: string[], json: boolean): Promise<number> {
  const useOnline = takeFlagBool(args, ['--online']);
  let tunnelId = useOnline ? undefined : args.shift();
  const method = args.shift();
  const rawParams = args.shift();

  if (!method) {
    process.stderr.write(
      `${status.err('Usage: kortix tunnel rpc <tunnelId|--online> <method> [jsonParams]')}\n` +
        `       e.g. kortix tunnel rpc --online shell.exec '{"command":"echo","args":["hi"]}'\n`,
    );
    return 2;
  }

  if (useOnline) {
    const conns = await client.get<TunnelConnection[]>('/tunnel/connections');
    const live = conns.find((c) => c.isLive);
    if (!live) {
      process.stderr.write(`${status.err('No computer is currently online.')}\n`);
      return 1;
    }
    tunnelId = live.tunnelId;
  }
  if (!tunnelId) {
    process.stderr.write(`${status.err('Provide a <tunnelId> or use --online.')}\n`);
    return 2;
  }

  let params: Record<string, unknown> = {};
  if (rawParams) {
    try {
      params = JSON.parse(rawParams);
    } catch {
      process.stderr.write(`${status.err('Params must be valid JSON.')}\n`);
      return 2;
    }
  }

  try {
    const result = await client.post<{ result: unknown }>(`/tunnel/rpc/${tunnelId}`, { method, params });
    if (json) {
      emitJson(result);
    } else {
      process.stdout.write(`${status.ok(`${method} →`)}\n${JSON.stringify(result.result, null, 2)}\n`);
    }
    return 0;
  } catch (err) {
    // A 403 here is a permission-required envelope, not a hard error — the
    // server has opened a request the owner must approve in the UI.
    if (err instanceof ApiError && err.status === 403) {
      const body = err.body as { requestId?: string; message?: string } | null;
      process.stderr.write(
        `${status.warn('Permission required.')} ${body?.message ?? ''}\n` +
          (body?.requestId ? `     Approve request ${C.cyan}${body.requestId}${C.reset} in the UI, then retry.\n` : ''),
      );
      return 1;
    }
    if (err instanceof ApiError && err.status === 502) {
      process.stderr.write(`${status.err('Computer is offline — the local agent is not connected.')}\n`);
      return 1;
    }
    return surfaceApiError(err);
  }
}

async function removeConnection(client: ApiClient, tunnelId: string | undefined): Promise<number> {
  if (!tunnelId) {
    process.stderr.write(`${status.err('Usage: kortix tunnel rm <tunnelId>')}\n`);
    return 2;
  }
  await client.delete(`/tunnel/connections/${tunnelId}`);
  process.stdout.write(`${status.ok(`Deleted connection ${tunnelId}`)}\n`);
  return 0;
}

// ── Entry ─────────────────────────────────────────────────────────────────────

export async function runTunnel(argv: string[]): Promise<number> {
  const args = [...argv];
  const hostArg = takeFlagValue(args, ['--host']);
  const json = takeFlagBool(args, ['--json']);
  const sub = args[0];

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  const client = resolveClient(hostArg);
  if (!client) return 1;

  try {
    switch (sub) {
      case 'ls':
      case 'list':
        return await listConnections(client, json);
      case 'show':
        return await showConnection(client, args[1], json);
      case 'rpc':
        return await relayRpc(client, args.slice(1), json);
      case 'rm':
      case 'delete':
        return await removeConnection(client, args[1]);
      default:
        process.stderr.write(`${status.err(`Unknown subcommand: ${sub}`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}
