/**
 * Shared tunnel RPC core — the one permission-check → relay → audit pipeline.
 *
 * Both the dedicated `POST /v1/tunnel/rpc/:tunnelId` route AND the Executor's
 * `computer` connector call go through `executeTunnelRpc`, so there is a single
 * code path for resolving a method's capability, checking the per-machine tunnel
 * permission, relaying over the WS, and writing the tunnel audit log. The route
 * translates the outcome union → HTTP status codes (unchanged contract); the
 * Executor maps it onto a CallResult.
 *
 * The computer helpers (`listAccountComputers`, `executeComputerCall`) sit here
 * too: they resolve a machine selector → tunnelId (scoped to the account) and
 * delegate to `executeTunnelRpc`. See docs/specs/computer-connector.md.
 */
import { eq } from 'drizzle-orm';
import { tunnelConnections, tunnelPermissionRequests } from '@kortix/db';
import { db } from '../../shared/db';
import { TunnelRelayError, TunnelMethods, TunnelErrorCode, type TunnelCapability } from 'agent-tunnel';
import { tunnelRelay } from './relay';
import { checkPermission } from './permission-checker';
import { writeAuditLog, buildRequestSummary } from './audit-logger';
import { notifyPermissionRequest } from '../routes/permission-requests';
import { tunnelRateLimiter } from './rate-limiter';
import { isValidCapability, validateScope as validateScopeInput } from './scope-validator';

/** Outcome of a single relayed tunnel RPC. The route + the executor each map this. */
export type TunnelRpcOutcome =
  | { ok: true; result: unknown }
  | { ok: false; kind: 'permission_required'; requestId: string; message: string }
  | { ok: false; kind: 'rate_limited'; retryAfterMs?: number; message: string }
  | { ok: false; kind: 'bad_request'; message: string }
  | { ok: false; kind: 'error'; code: number; httpStatus: 500 | 502 | 504; message: string };

/** Map a tunnel method to its capability (explicit table first, then prefix). */
export function resolveCapability(method: string): TunnelCapability | null {
  const mapped = (TunnelMethods as Record<string, string | null>)[method];
  if (mapped !== undefined) {
    return mapped as TunnelCapability | null;
  }
  const prefix = method.split('.')[0];
  const prefixMap: Record<string, TunnelCapability> = {
    fs: 'filesystem',
    shell: 'shell',
    desktop: 'desktop',
  };
  return prefixMap[prefix] || null;
}

/**
 * Run one RPC against a tunnel: rate-limit → resolve capability → check the
 * per-machine permission (creating a permission request on deny) → relay →
 * audit. Ownership of the tunnel (account scoping) is the CALLER's job — the
 * `/rpc` route enforces its ownerClause, the executor resolves the tunnel within
 * the account — so this core is purely the permission/relay/audit pipeline.
 */
export async function executeTunnelRpc(input: {
  tunnelId: string;
  accountId: string;
  method: string;
  params: Record<string, unknown>;
}): Promise<TunnelRpcOutcome> {
  const { tunnelId, accountId, method, params } = input;

  const rpcRateCheck = tunnelRateLimiter.check('rpc', tunnelId);
  if (!rpcRateCheck.allowed) {
    return { ok: false, kind: 'rate_limited', retryAfterMs: rpcRateCheck.retryAfterMs, message: 'Rate limit exceeded' };
  }

  if (!method || typeof method !== 'string') {
    return { ok: false, kind: 'bad_request', message: 'method is required' };
  }

  const capability = resolveCapability(method);
  if (!capability) {
    return { ok: false, kind: 'bad_request', message: `Unknown method: ${method}` };
  }
  if (!isValidCapability(capability)) {
    return { ok: false, kind: 'bad_request', message: `Invalid capability: ${capability}` };
  }

  const capPrefix = method.indexOf('.');
  const operation = capPrefix !== -1 ? method.slice(capPrefix + 1) : method;
  const permCheck = await checkPermission(tunnelId, capability, operation, params);

  if (!permCheck.allowed) {
    const permReqRateCheck = tunnelRateLimiter.check('permRequest', accountId);
    if (!permReqRateCheck.allowed) {
      return { ok: false, kind: 'rate_limited', retryAfterMs: permReqRateCheck.retryAfterMs, message: 'Too many permission requests' };
    }

    const scopeValidation = validateScopeInput(capability, params);
    const requestedScope = scopeValidation.valid ? (scopeValidation.sanitized || params) : params;

    const [request] = await db
      .insert(tunnelPermissionRequests)
      .values({
        tunnelId,
        accountId,
        capability,
        requestedScope,
        reason: `Agent requested ${method} — ${permCheck.reason}`,
      })
      .returning();

    notifyPermissionRequest(accountId, request);

    return {
      ok: false,
      kind: 'permission_required',
      requestId: request.requestId,
      message: permCheck.reason ?? 'Permission required',
    };
  }

  const startTime = Date.now();
  try {
    const result = await tunnelRelay.relayRPC(tunnelId, method, {
      ...params,
      permissionId: permCheck.permissionId,
    });

    writeAuditLog({
      tunnelId,
      accountId,
      capability,
      operation: method,
      requestSummary: buildRequestSummary(method, params),
      success: true,
      durationMs: Date.now() - startTime,
      bytesTransferred: estimateBytes(result),
    });

    return { ok: true, result };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof TunnelRelayError ? err.code : TunnelErrorCode.LOCAL_ERROR;

    writeAuditLog({
      tunnelId,
      accountId,
      capability,
      operation: method,
      requestSummary: buildRequestSummary(method, params),
      success: false,
      durationMs: Date.now() - startTime,
      errorMessage,
    });

    const httpStatus: 500 | 502 | 504 =
      errorCode === TunnelErrorCode.NOT_CONNECTED ? 502 : errorCode === TunnelErrorCode.TIMEOUT ? 504 : 500;

    return { ok: false, kind: 'error', code: errorCode, httpStatus, message: errorMessage };
  }
}

function estimateBytes(result: unknown): number {
  if (result === null || result === undefined) return 0;
  if (typeof result === 'string') return result.length;
  try {
    return JSON.stringify(result).length;
  } catch {
    return 0;
  }
}

// ─── Computer connector helpers ───────────────────────────────────────────────

/** A machine as the executor surfaces it (`list_computers`). */
export interface ComputerMachine {
  id: string;
  name: string;
  online: boolean;
  capabilities: string[];
  platform: string | null;
}

/** Every machine connected to an account, with live online status from the relay. */
export async function listAccountComputers(accountId: string): Promise<ComputerMachine[]> {
  const rows = await db
    .select()
    .from(tunnelConnections)
    .where(eq(tunnelConnections.accountId, accountId));
  return rows.map((r) => ({
    id: r.tunnelId,
    name: r.name,
    online: tunnelRelay.isConnected(r.tunnelId),
    capabilities: Array.isArray(r.capabilities) ? (r.capabilities as string[]) : [],
    platform: (r.machineInfo as Record<string, unknown> | null)?.platform as string | null ?? null,
  }));
}

type ResolveResult = { ok: true; tunnelId: string } | { ok: false; message: string };

/** Resolve a machine selector (id or name) → tunnelId, scoped to the account. */
async function resolveComputerTunnel(accountId: string, selector: string | null): Promise<ResolveResult> {
  const machines = await listAccountComputers(accountId);
  if (machines.length === 0) {
    return { ok: false, message: 'No machines are connected to this account. Connect one in Computers (or run `kortix tunnel`).' };
  }
  if (selector) {
    const byId = machines.find((m) => m.id === selector);
    if (byId) return { ok: true, tunnelId: byId.id };
    const byName = machines.filter((m) => m.name.toLowerCase() === selector.toLowerCase());
    if (byName.length === 1) return { ok: true, tunnelId: byName[0]!.id };
    if (byName.length > 1) {
      return { ok: false, message: `Multiple machines are named "${selector}" — pass the id from list_computers instead.` };
    }
    return { ok: false, message: `No machine matches "${selector}". Available: ${machines.map((m) => m.name).join(', ')}.` };
  }
  const online = machines.filter((m) => m.online);
  if (online.length === 1) return { ok: true, tunnelId: online[0]!.id };
  if (online.length === 0) {
    return { ok: false, message: `No machine is online. Connected: ${machines.map((m) => m.name).join(', ')}. Bring one online and retry.` };
  }
  return { ok: false, message: `Multiple machines are online (${online.map((m) => m.name).join(', ')}). Pass "computer" (name or id) to choose one.` };
}

/** Outcome of a `computer` connector call, mapped onto a CallResult by the gateway. */
export type ComputerCallOutcome =
  | { ok: true; data: unknown }
  | { ok: false; kind: 'permission_required'; requestId: string; message: string }
  | { ok: false; kind: 'no_machine'; message: string }
  | { ok: false; kind: 'error'; message: string };

/**
 * Execute a `computer` connector action: the meta `list_computers` server-side,
 * everything else resolved to a machine (selector, scoped to the account) and
 * relayed through `executeTunnelRpc`. The gateway calls this for provider
 * `computer`.
 */
export async function executeComputerCall(input: {
  accountId: string;
  selector: string | null;
  method: string;
  args: Record<string, unknown>;
}): Promise<ComputerCallOutcome> {
  if (input.method === 'list_computers') {
    return { ok: true, data: { computers: await listAccountComputers(input.accountId) } };
  }

  const resolved = await resolveComputerTunnel(input.accountId, input.selector);
  if (!resolved.ok) return { ok: false, kind: 'no_machine', message: resolved.message };

  const outcome = await executeTunnelRpc({
    tunnelId: resolved.tunnelId,
    accountId: input.accountId,
    method: input.method,
    params: input.args,
  });

  if (outcome.ok) return { ok: true, data: outcome.result };
  if (outcome.kind === 'permission_required') {
    return { ok: false, kind: 'permission_required', requestId: outcome.requestId, message: outcome.message };
  }
  if (outcome.kind === 'rate_limited') {
    const retry = outcome.retryAfterMs ? ` (retry in ${Math.ceil(outcome.retryAfterMs / 1000)}s)` : '';
    return { ok: false, kind: 'error', message: `${outcome.message}${retry}` };
  }
  return { ok: false, kind: 'error', message: outcome.message };
}
