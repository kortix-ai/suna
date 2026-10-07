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
import { config } from '../../config';
import { db } from '../../shared/db';
import { accountMemberRow } from '../../iam/membership-read';
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
      httpStatus: 403 | 500 | 502 | 504;
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
      // In `ask` mode the machine holds a call up to ACCESS_HOLD_MS for its
      // owner before it runs. That hold must not eat the call's own budget: a
      // late approval would run the call while the caller already got a timeout.
      timeoutMs: config.TUNNEL_RPC_TIMEOUT_MS + (machineAccess(connection?.machineInfo)?.mode === 'ask' ? ACCESS_HOLD_MS : 0),
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

    // The owner's access decision on the machine (X1) is a refusal, not a fault.
    const httpStatus: 403 | 500 | 502 | 504 = computerAccessErrorKind(errorCode, errorMessage)
      ? 403
      : errorCode === TunnelErrorCode.NOT_CONNECTED
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
      kind:
        | 'computer_unpaired'
        | 'computer_owner_left'
        | 'computer_offline'
        | 'computer_capability_not_approved'
        | ComputerAccessErrorKind
        | 'error';
      message: string;
    };

/** How long an `ask`-mode machine holds a call for its owner (agent-tunnel ACCESS_HOLD_MS). */
const ACCESS_HOLD_MS = 20_000;

/**
 * v2 X1: the agent refuses a call on the machine itself (access.json). Codes
 * are binding across the agent and the API; the message prefix is the
 * fallback for a relay that lost the code.
 */
const ACCESS_ERRORS = {
  [-32010]: 'computer_access_pending',
  [-32011]: 'computer_access_denied',
  [-32012]: 'computer_access_off',
} as const;
export type ComputerAccessErrorKind = (typeof ACCESS_ERRORS)[keyof typeof ACCESS_ERRORS];

export function computerAccessErrorKind(code: number, message: string): ComputerAccessErrorKind | null {
  const byCode = ACCESS_ERRORS[code as keyof typeof ACCESS_ERRORS];
  if (byCode) return byCode;
  return Object.values(ACCESS_ERRORS).find((kind) => message.startsWith(`${kind}:`)) ?? null;
}

/** What the agent should tell the user, per access refusal. Never loop-retry. */
function computerAccessMessage(kind: ComputerAccessErrorKind, machine: string): string {
  switch (kind) {
    case 'computer_access_pending':
      return `${machine} is asking its owner to allow access. Tell the user to approve the prompt on that computer, then retry once they confirm. Do not retry before that.`;
    case 'computer_access_denied':
      return `The owner of ${machine} denied access. It stays denied for 10 minutes. Ask the user before retrying.`;
    case 'computer_access_off':
      return `Access to ${machine} is turned off on that computer. Ask the user to allow access from the Kortix menu on that computer.`;
  }
}

/** The machine's last reported access mode (`tunnel.access.state`), or null. A lapsed grant is no grant. */
export function machineAccess(
  machineInfo: unknown,
  now = Date.now(),
): { mode: 'ask' | 'always' | 'off'; granted_until: string | null } | null {
  const access = (machineInfo as Record<string, unknown> | null)?.access as
    | { mode?: unknown; grantedUntil?: unknown }
    | undefined;
  if (!access || (access.mode !== 'ask' && access.mode !== 'always' && access.mode !== 'off')) {
    return null;
  }
  return {
    mode: access.mode,
    granted_until:
      typeof access.grantedUntil === 'string' && Date.parse(access.grantedUntil) > now ? access.grantedUntil : null,
  };
}

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
  // A paired machine keeps its owner after the owner leaves the account. Its
  // agents must not keep reaching that person's disk and shell (KRTX-1722).
  if (machine.ownerUserId && !(await accountMemberRow(input.accountId, machine.ownerUserId))[0]) {
    return {
      ok: false,
      kind: 'computer_owner_left',
      message: `${machine.name} belongs to someone who is no longer a member of this account, so it cannot be used here.`,
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
        access: machineAccess(machine.machineInfo),
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
  const access = outcome.kind === 'error' ? computerAccessErrorKind(outcome.code, outcome.message) : null;
  if (access) return { ok: false, kind: access, message: computerAccessMessage(access, machine.name) };
  if (outcome.kind === 'rate_limited') {
    const retry = outcome.retryAfterMs
      ? ` (retry in ${Math.ceil(outcome.retryAfterMs / 1000)}s)`
      : '';
    return { ok: false, kind: 'error', message: `${outcome.message}${retry}` };
  }
  return { ok: false, kind: 'error', message: outcome.message };
}
