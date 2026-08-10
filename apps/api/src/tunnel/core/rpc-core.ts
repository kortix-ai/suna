/**
 * Shared tunnel RPC core — the one permission-check → relay → audit pipeline.
 *
 * Both the dedicated `POST /v1/tunnel/rpc/:tunnelId` route AND the Connector's
 * `computer` connector call go through `executeTunnelRpc`, so there is a single
 * code path for resolving a method's capability, checking the per-machine tunnel
 * permission, relaying over the WS, and writing the tunnel audit log. The route
 * translates the outcome union → HTTP status codes (unchanged contract); the
 * Connector maps it onto a CallResult.
 *
 * The computer helpers (`listAccountComputers`, `executeComputerCall`) sit here
 * too. A connector profile supplies an allowlist of account-owned tunnel ids.
 */
import { tunnelConnections, tunnelPermissionRequests } from '@kortix/db';
import {
  type TunnelCapability,
  capabilityForMethod,
  desktopFeatureForMethod,
  operationForMethod,
  TunnelErrorCode,
  TunnelRelayError,
} from 'agent-tunnel';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../shared/db';
import { notifyPermissionRequest } from '../routes/permission-requests';
import { buildRequestSummary, finishAuditLog, startAuditLog } from './audit-logger';
import { isTunnelConnectionLive, relayRpcToConnectedAgent } from './cluster-forwarder';
import { checkPermission } from './permission-checker';
import { tunnelRateLimiter } from './rate-limiter';
import { isValidCapability, validateScope as validateScopeInput } from './scope-validator';

/** Outcome of a single relayed tunnel RPC. The route + the connector each map this. */
export type TunnelRpcOutcome =
  | { ok: true; result: unknown }
  | {
      ok: false;
      kind: 'permission_required';
      requestId: string;
      message: string;
    }
  | { ok: false; kind: 'rate_limited'; retryAfterMs?: number; message: string }
  | { ok: false; kind: 'bad_request'; message: string }
  | {
      ok: false;
      kind: 'error';
      code: number;
      httpStatus: 500 | 502 | 504;
      message: string;
    };

/** Map a tunnel method to its capability (explicit table first, then prefix). */
export function resolveCapability(method: string): TunnelCapability | null {
  return capabilityForMethod(method);
}

/**
 * Run one RPC against a tunnel: rate-limit → resolve capability → check the
 * per-machine permission (creating a permission request on deny) → relay →
 * audit. Ownership of the tunnel (account scoping) is the CALLER's job — the
 * `/rpc` route enforces its ownerClause, the connector resolves the tunnel within
 * the account — so this core is purely the permission/relay/audit pipeline.
 */
export async function executeTunnelRpc(input: {
  tunnelId: string;
  /** Physical machine owner. Defaults to the audit/project account. */
  tunnelOwnerAccountId?: string;
  accountId: string;
  projectId?: string | null;
  sessionId?: string | null;
  actorUserId?: string | null;
  method: string;
  params: Record<string, unknown>;
}): Promise<TunnelRpcOutcome> {
  const { tunnelId, accountId, method, params } = input;
  const permissionOwnerAccountId = input.tunnelOwnerAccountId ?? accountId;

  const rpcRateCheck = tunnelRateLimiter.check('rpc', tunnelId);
  if (!rpcRateCheck.allowed) {
    return {
      ok: false,
      kind: 'rate_limited',
      retryAfterMs: rpcRateCheck.retryAfterMs,
      message: 'Rate limit exceeded',
    };
  }

  if (!method || typeof method !== 'string') {
    return { ok: false, kind: 'bad_request', message: 'method is required' };
  }

  const capability = resolveCapability(method);
  if (!capability) {
    return {
      ok: false,
      kind: 'bad_request',
      message: `Unknown method: ${method}`,
    };
  }
  if (!isValidCapability(capability)) {
    return {
      ok: false,
      kind: 'bad_request',
      message: `Invalid capability: ${capability}`,
    };
  }

  const [connection] = await db
    .select({
      capabilities: tunnelConnections.capabilities,
      machineInfo: tunnelConnections.machineInfo,
    })
    .from(tunnelConnections)
    .where(eq(tunnelConnections.tunnelId, tunnelId))
    .limit(1);
  const approvedCapabilities = Array.isArray(connection?.capabilities)
    ? connection.capabilities
    : [];
  const registeredCapabilities = (connection?.machineInfo as Record<string, unknown> | null)
    ?.registeredCapabilities;
  const effectiveCapabilities = Array.isArray(registeredCapabilities)
    ? approvedCapabilities.filter((item) => registeredCapabilities.includes(item))
    : approvedCapabilities;
  if (!effectiveCapabilities.includes(capability)) {
    return {
      ok: false,
      kind: 'bad_request',
      message: `Capability is not registered by the connected Agent Tunnel: ${capability}. Update and reconnect the local agent.`,
    };
  }

  const operation = operationForMethod(method);
  const permCheck = await checkPermission(tunnelId, capability, operation, params);

  if (!permCheck.allowed) {
    const permReqRateCheck = tunnelRateLimiter.check('permRequest', permissionOwnerAccountId);
    if (!permReqRateCheck.allowed) {
      return {
        ok: false,
        kind: 'rate_limited',
        retryAfterMs: permReqRateCheck.retryAfterMs,
        message: 'Too many permission requests',
      };
    }

    const requestedScope = requestedScopeForOperation(capability, method, operation, params);

    const [request] = await db
      .insert(tunnelPermissionRequests)
      .values({
        tunnelId,
        accountId: permissionOwnerAccountId,
        capability,
        requestedScope,
        reason: `Agent requested ${method} — ${permCheck.reason}`,
      })
      .returning();

    notifyPermissionRequest(permissionOwnerAccountId, request);

    return {
      ok: false,
      kind: 'permission_required',
      requestId: request.requestId,
      message: permCheck.reason ?? 'Permission required',
    };
  }

  const startTime = Date.now();
  const auditLogId = await startAuditLog({
    tunnelId,
    accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    actorType: input.sessionId ? 'agent' : input.actorUserId ? 'human' : 'system',
    capability,
    operation: method,
    requestSummary: buildRequestSummary(method, params),
  });
  let result: unknown;
  try {
    result = await relayRpcToConnectedAgent({
      tunnelId,
      accountId: input.tunnelOwnerAccountId ?? accountId,
      method,
      params: {
        ...params,
        permissionId: permCheck.permissionId,
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof TunnelRelayError ? err.code : TunnelErrorCode.LOCAL_ERROR;

    try {
      await finishAuditLog(auditLogId, {
        success: false,
        durationMs: Date.now() - startTime,
        errorMessage,
      });
    } catch (auditError) {
      // The durable started row remains pending. Do not replace the original
      // relay error or cause a caller to misclassify the external operation.
      console.error('[tunnel-audit] failed to persist terminal failure', auditError);
    }

    const httpStatus: 500 | 502 | 504 =
      errorCode === TunnelErrorCode.NOT_CONNECTED
        ? 502
        : errorCode === TunnelErrorCode.TIMEOUT
          ? 504
          : 500;

    return {
      ok: false,
      kind: 'error',
      code: errorCode,
      httpStatus,
      message: errorMessage,
    };
  }

  try {
    await finishAuditLog(auditLogId, {
      success: true,
      durationMs: Date.now() - startTime,
      bytesTransferred: estimateBytes(result),
    });
  } catch (auditError) {
    // The remote action already completed. Returning an error here can cause a
    // destructive caller retry. Preserve the durable started row and alert.
    console.error('[tunnel-audit] failed to persist terminal success', auditError);
  }

  return { ok: true, result };
}

function requestedScopeForOperation(
  capability: TunnelCapability,
  method: string,
  operation: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  let candidate: Record<string, unknown> = {};
  if (capability === 'filesystem') {
    candidate = {
      operations: [operation],
      ...(typeof params.path === 'string' && params.path.length > 0
        ? { paths: [params.path] }
        : {}),
    };
  } else if (capability === 'shell') {
    const command = typeof params.command === 'string' ? params.command.trim() : '';
    candidate = {
      ...(command ? { commands: [command] } : {}),
      ...(typeof params.cwd === 'string' && params.cwd.length > 0
        ? { workingDir: params.cwd }
        : {}),
      ...(typeof params.timeout === 'number' &&
      Number.isFinite(params.timeout) &&
      params.timeout > 0
        ? { maxTimeout: params.timeout }
        : {}),
    };
  } else if (capability === 'desktop') {
    const feature = desktopFeatureForMethod(method, params);
    candidate = feature ? { features: [feature] } : {};
  }

  const validated = validateScopeInput(capability, candidate);
  return validated.valid ? (validated.sanitized ?? {}) : {};
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

/** Profile-scoped machine-list shape exposed by `list_computers`. */
export interface ComputerMachine {
  id: string;
  name: string;
  online: boolean;
  capabilities: string[];
  platform: string | null;
}

interface ResolvedComputerMachine extends ComputerMachine {
  ownerAccountId: string;
}

/** List assigned account machines with DB-backed online status. Null is legacy all-account access. */
export async function listAccountComputers(
  accountId: string,
  allowedTunnelIds: readonly string[] | null = null,
  allowedTunnelAccountIds: readonly string[] | null = null,
): Promise<ResolvedComputerMachine[]> {
  const allowed = allowedTunnelIds === null ? null : [...new Set(allowedTunnelIds)];
  if (allowed?.length === 0) return [];
  const allowedAccounts =
    allowed === null
      ? [accountId]
      : [...new Set(allowedTunnelAccountIds?.length ? allowedTunnelAccountIds : [accountId])];
  if (allowedAccounts.length === 0) return [];
  const rows = await db
    .select()
    .from(tunnelConnections)
    .where(
      allowed
        ? and(
            inArray(tunnelConnections.accountId, allowedAccounts),
            inArray(tunnelConnections.tunnelId, allowed),
          )
        : eq(tunnelConnections.accountId, accountId),
    );
  return rows.map((r) => ({
    id: r.tunnelId,
    ownerAccountId: r.accountId,
    name: r.name,
    online: isTunnelConnectionLive(r),
    capabilities: (() => {
      const approved = Array.isArray(r.capabilities) ? (r.capabilities as string[]) : [];
      const registered = (r.machineInfo as Record<string, unknown> | null)?.registeredCapabilities;
      return Array.isArray(registered)
        ? approved.filter((capability) => registered.includes(capability))
        : approved;
    })(),
    platform:
      ((r.machineInfo as Record<string, unknown> | null)?.platform as string | null) ?? null,
  }));
}

type ResolveResult =
  | { ok: true; tunnelId: string; tunnelOwnerAccountId: string }
  | { ok: false; message: string };

/** Resolve a selector inside one connector profile's already-filtered machine set. */
async function resolveComputerTunnel(
  machines: ResolvedComputerMachine[],
  selector: string | null,
): Promise<ResolveResult> {
  if (machines.length === 0) {
    return {
      ok: false,
      message: 'No machines are assigned to this Computer Tunnel connector profile.',
    };
  }
  if (selector) {
    const byId = machines.find((m) => m.id === selector);
    if (byId) {
      return {
        ok: true,
        tunnelId: byId.id,
        tunnelOwnerAccountId: byId.ownerAccountId,
      };
    }
    const byName = machines.filter((m) => m.name.toLowerCase() === selector.toLowerCase());
    const [byNameMachine] = byName;
    if (byNameMachine && byName.length === 1) {
      return {
        ok: true,
        tunnelId: byNameMachine.id,
        tunnelOwnerAccountId: byNameMachine.ownerAccountId,
      };
    }
    if (byName.length > 1) {
      return {
        ok: false,
        message: `Multiple machines are named "${selector}" — pass the id from list_computers instead.`,
      };
    }
    return {
      ok: false,
      message: `Machine "${selector}" is not assigned to this connector profile. Available: ${machines.map((m) => m.name).join(', ')}.`,
    };
  }
  const online = machines.filter((m) => m.online);
  const [onlineMachine] = online;
  if (onlineMachine && online.length === 1) {
    return {
      ok: true,
      tunnelId: onlineMachine.id,
      tunnelOwnerAccountId: onlineMachine.ownerAccountId,
    };
  }
  if (online.length === 0) {
    return {
      ok: false,
      message: `No machine is online. Connected: ${machines.map((m) => m.name).join(', ')}. Bring one online and retry.`,
    };
  }
  return {
    ok: false,
    message: `Multiple machines are online (${online.map((m) => m.name).join(', ')}). Pass "computer" (name or id) to choose one.`,
  };
}

/** Outcome of a `computer` connector call, mapped onto a CallResult by the gateway. */
export type ComputerCallOutcome =
  | { ok: true; data: unknown }
  | {
      ok: false;
      kind: 'permission_required';
      requestId: string;
      message: string;
    }
  | { ok: false; kind: 'no_machine'; message: string }
  | { ok: false; kind: 'error'; message: string };

/**
 * Execute one Computer Tunnel connector action. Listing and selection use the same
 * server-side allowlist. The DB query also verifies account ownership, so a
 * stale, deleted, unassigned, or cross-account tunnel fails closed.
 */
export async function executeComputerCall(input: {
  accountId: string;
  projectId?: string | null;
  sessionId?: string | null;
  actorUserId?: string | null;
  /** Null is accepted only for legacy aggregate rows and means all account machines. */
  allowedTunnelIds: string[] | null;
  /** Verified owner accounts stored with an explicit profile. */
  allowedTunnelAccountIds?: string[] | null;
  selector: string | null;
  method: string;
  args: Record<string, unknown>;
}): Promise<ComputerCallOutcome> {
  const machines = await listAccountComputers(
    input.accountId,
    input.allowedTunnelIds,
    input.allowedTunnelAccountIds,
  );
  if (input.method === 'list_computers') {
    return {
      ok: true,
      data: {
        computers: machines.map(({ ownerAccountId: _ownerAccountId, ...machine }) => machine),
      },
    };
  }
  const resolved = await resolveComputerTunnel(machines, input.selector);
  if (!resolved.ok) return { ok: false, kind: 'no_machine', message: resolved.message };

  const outcome = await executeTunnelRpc({
    tunnelId: resolved.tunnelId,
    tunnelOwnerAccountId: resolved.tunnelOwnerAccountId,
    accountId: input.accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    method: input.method,
    params: input.args,
  });

  if (outcome.ok) return { ok: true, data: outcome.result };
  if (outcome.kind === 'permission_required') {
    return {
      ok: false,
      kind: 'permission_required',
      requestId: outcome.requestId,
      message: outcome.message,
    };
  }
  if (outcome.kind === 'rate_limited') {
    const retry = outcome.retryAfterMs
      ? ` (retry in ${Math.ceil(outcome.retryAfterMs / 1000)}s)`
      : '';
    return { ok: false, kind: 'error', message: `${outcome.message}${retry}` };
  }
  return { ok: false, kind: 'error', message: outcome.message };
}
