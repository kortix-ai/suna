/**
 * Shared tunnel RPC core — the one permission-check → relay → audit pipeline.
 *
 * Both the dedicated `POST /v1/tunnel/rpc/:tunnelId` route AND the Connector's
 * `computer` connector call go through `executeTunnelRpc`, so there is a single
 * code path for resolving a method's capability, checking the machine's wire
 * permission, relaying over the WS, and writing the tunnel audit log. The route
 * translates the outcome union → HTTP status codes; the Connector maps it onto a
 * CallResult.
 *
 * Wire permissions (`tunnel_permissions`) are minted at pairing, one full-scope
 * grant per approved capability, because installed agents require a synced
 * `permissionId` on every RPC. They are not a product surface: a missing grant
 * means the capability was not approved at pairing, and the fix is re-pairing.
 * Human approval of risky calls is the generic connector policy
 * (`require_approval`).
 */
import { tunnelConnections } from '@kortix/db';
import {
  validateFilesystemParams,
  capabilityForMethod,
  operationForMethod,
  TunnelErrorCode,
  TunnelRelayError,
  type TunnelCapability,
} from 'agent-tunnel';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { buildRequestSummary, finishAuditLog, startAuditLog } from './audit-logger';
import { isTunnelConnectionLive, relayRpcToConnectedAgent } from './cluster-forwarder';
import { checkPermission } from './permission-checker';
import { tunnelRateLimiter } from './rate-limiter';
import { isValidCapability } from './scope-validator';

/** Outcome of a single relayed tunnel RPC. The route + the connector each map this. */
export type TunnelRpcOutcome =
  | { ok: true; result: unknown }
  | {
      ok: false;
      kind: 'capability_not_approved';
      capability: string;
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
 * machine's wire permission → relay → audit. Ownership of the tunnel is the
 * CALLER's job — the `/rpc` route enforces its ownerClause, the connector
 * resolves the account's machine — so this core is purely the
 * permission/relay/audit pipeline.
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

  const validationError = validateFilesystemParams(method, params);
  if (validationError) return { ok: false, kind: 'bad_request', message: validationError };

  const [connection] = await db
    .select({
      capabilities: tunnelConnections.capabilities,
      machineInfo: tunnelConnections.machineInfo,
    })
    .from(tunnelConnections)
    .where(eq(tunnelConnections.tunnelId, tunnelId))
    .limit(1);
  const notApproved = {
    ok: false,
    kind: 'capability_not_approved',
    capability,
    message: `The ${capability} capability was not approved when this computer was paired. Re-pair this computer to allow ${capability}.`,
  } as const;
  const approvedCapabilities = Array.isArray(connection?.capabilities)
    ? connection.capabilities
    : [];
  if (!approvedCapabilities.includes(capability)) return notApproved;
  if (!connection || !effectiveMachineCapabilities(connection).includes(capability)) {
    return {
      ok: false,
      kind: 'bad_request',
      message: `Capability is not registered by the connected Agent Tunnel: ${capability}. Update and reconnect the local agent.`,
    };
  }

  const operation = operationForMethod(method);
  const permCheck = await checkPermission(tunnelId, capability, operation, params);
  if (!permCheck.allowed) return notApproved;

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

function estimateBytes(result: unknown): number {
  if (result === null || result === undefined) return 0;
  if (typeof result === 'string') return result.length;
  try {
    return JSON.stringify(result).length;
  } catch {
    return 0;
  }
}

// ─── Computer connector call ──────────────────────────────────────────────────

/** Outcome of a `computer` connector call, mapped onto a CallResult by the gateway. */
export type ComputerCallOutcome =
  | { ok: true; data: unknown }
  | {
      ok: false;
      kind: 'computer_unpaired' | 'computer_offline' | 'computer_capability_not_approved' | 'error';
      message: string;
    };

/** Approved capabilities the connected agent also registered. */
export function effectiveMachineCapabilities(row: {
  capabilities: unknown;
  machineInfo: unknown;
}): string[] {
  const approved = Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [];
  const registered = (row.machineInfo as Record<string, unknown> | null)?.registeredCapabilities;
  return Array.isArray(registered)
    ? approved.filter((capability) => registered.includes(capability))
    : approved;
}

/**
 * Execute one computer connector action on the machine of the account the
 * generic connection resolver chose. `status` is answered server-side.
 */
export async function executeComputerCall(input: {
  tunnelId: string;
  accountId: string;
  projectId?: string | null;
  sessionId?: string | null;
  actorUserId?: string | null;
  method: string;
  args: Record<string, unknown>;
}): Promise<ComputerCallOutcome> {
  const [machine] = await db
    .select()
    .from(tunnelConnections)
    .where(eq(tunnelConnections.tunnelId, input.tunnelId))
    .limit(1);
  if (!machine) {
    return {
      ok: false,
      kind: 'computer_unpaired',
      message: 'This computer was unpaired. Pair it again to use it.',
    };
  }
  const online = isTunnelConnectionLive(machine);
  const info = (machine.machineInfo ?? {}) as Record<string, unknown>;
  if (input.method === 'status') {
    return {
      ok: true,
      data: {
        name: machine.name,
        online,
        platform: typeof info.platform === 'string' ? info.platform : null,
        hostname: typeof info.hostname === 'string' ? info.hostname : null,
        home_dir: typeof info.homeDir === 'string' ? info.homeDir : null,
        allowed_paths: Array.isArray(info.allowedPaths)
          ? info.allowedPaths.filter((path): path is string => typeof path === 'string')
          : null,
        capabilities: effectiveMachineCapabilities(machine),
        last_heartbeat_at: machine.lastHeartbeatAt?.toISOString() ?? null,
      },
    };
  }
  if (!online) {
    return {
      ok: false,
      kind: 'computer_offline',
      message: `${machine.name} is offline. Start Kortix on that computer and retry.`,
    };
  }

  const outcome = await executeTunnelRpc({
    tunnelId: machine.tunnelId,
    tunnelOwnerAccountId: machine.accountId,
    accountId: input.accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    method: input.method,
    params: input.args,
  });

  if (outcome.ok) return { ok: true, data: outcome.result };
  if (outcome.kind === 'capability_not_approved') {
    return { ok: false, kind: 'computer_capability_not_approved', message: outcome.message };
  }
  if (outcome.kind === 'error' && outcome.code === TunnelErrorCode.NOT_CONNECTED) {
    return { ok: false, kind: 'computer_offline', message: outcome.message };
  }
  if (outcome.kind === 'rate_limited') {
    const retry = outcome.retryAfterMs
      ? ` (retry in ${Math.ceil(outcome.retryAfterMs / 1000)}s)`
      : '';
    return { ok: false, kind: 'error', message: `${outcome.message}${retry}` };
  }
  return { ok: false, kind: 'error', message: outcome.message };
}
