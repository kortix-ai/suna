import { and, eq, lt, sql } from 'drizzle-orm';
import { tunnelConnections, tunnelRpcForwards } from '@kortix/db';
import { capabilityForMethod, TunnelErrorCode, TunnelRelayError } from 'agent-tunnel';
import { config } from '../../lib/config';
import { db } from '../../shared/db';
import { runWorkerTick } from '../../shared/audit-scope';
import { fingerprintTunnelCredentialHash } from '../../shared/crypto';
import { API_INSTANCE, API_INSTANCE_ID, API_STARTED_AT } from '../../shared/instance';
import {
  TUNNEL_FORWARD_CHANNEL,
  isPgBroadcastListening,
  onTunnelForwardNotify,
} from '../../shared/pg-broadcast';
import { tunnelRelay } from './relay';

// A NOTIFY on TUNNEL_FORWARD_CHANNEL wakes both loops: the owner's forwarder
// when a row is queued for it, the requester when its result is written. The
// NOTIFY is an optimisation, never an authority, so both loops still poll.
// Without the LISTEN (a transaction pooler, a failed subscription) they poll
// every FORWARD_POLL_MS, the rate before NOTIFY existed. With it, the poll only
// covers a lost NOTIFY: at most FORWARDER_FALLBACK_MS added to the pickup and
// FORWARD_RESULT_FALLBACK_MS to the result. Both stay under FORWARD_TTL_PAD_MS.
const FORWARD_POLL_MS = 100;
const FORWARDER_FALLBACK_MS = 1_000;
const FORWARD_RESULT_FALLBACK_MS = 1_000;
const FORWARD_BATCH_SIZE = 16;
const FORWARDER_ERROR_MS = 1_000;
const FORWARD_TTL_PAD_MS = 5_000;
// Expired rows are rows whose requester died. One sweep per interval removes
// them; it does not need to run on every tick.
const FORWARD_EXPIRY_SWEEP_MS = 30_000;

const rpcTimeoutMs = (requested?: number) => Math.max(1_000, requested ?? config.TUNNEL_RPC_TIMEOUT_MS);

type ForwardRow = typeof tunnelRpcForwards.$inferSelect;

let forwarderTimer: ReturnType<typeof setTimeout> | null = null;
let forwarderRunning = false;
let forwarderStopped = true;
let forwarderWoken = false;
let lastExpirySweepAt = 0;
/** One entry per forward this replica waits on, keyed by request id. */
// replica-local: the pg broadcast routes each "done" payload to the exact
// replica that issued the request (the payload IS that replica's id), so a
// waiter is only ever woken in the process that created it. A replica that
// misses the notify falls back to its own LISTEN/poll loop below.
const resultWaiters = new Map<string, () => void>();

/** The poll interval of a loop whose LISTEN-backed fallback is `fallbackMs`. */
export function forwardPollMs(fallbackMs: number, listening = isPgBroadcastListening()): number {
  return listening ? fallbackMs : FORWARD_POLL_MS;
}

// Payload = this replica's id: a row is queued for it. Otherwise a request id.
onTunnelForwardNotify((payload) => {
  if (payload === API_INSTANCE_ID) wakeForwarder();
  else resultWaiters.get(payload)?.();
});

export function tunnelLiveWindowMs(): number {
  return config.TUNNEL_HEARTBEAT_INTERVAL_MS * (config.TUNNEL_HEARTBEAT_MAX_MISSED + 1) + 15_000;
}

export function isTunnelConnectionLive(row: {
  status: string;
  lastHeartbeatAt?: Date | string | null;
  relayOwnerHeartbeatAt?: Date | string | null;
  relayOwnerId?: string | null;
}): boolean {
  if (row.status !== 'online' || !row.relayOwnerId) return false;
  const heartbeat = row.relayOwnerHeartbeatAt ?? row.lastHeartbeatAt;
  if (!heartbeat) return false;
  const at = heartbeat instanceof Date ? heartbeat.getTime() : new Date(heartbeat).getTime();
  return Number.isFinite(at) && Date.now() - at <= tunnelLiveWindowMs();
}

export function relayOwnerPatch(now = new Date()) {
  return {
    relayOwnerId: API_INSTANCE_ID,
    relayOwnerInstance: API_INSTANCE,
    relayOwnerStartedAt: new Date(API_STARTED_AT),
    relayOwnerHeartbeatAt: now,
  };
}

export async function markTunnelRelayOwner(
  tunnelId: string,
  extra: Partial<typeof tunnelConnections.$inferInsert> = {},
) {
  const now = new Date();
  await db
    .update(tunnelConnections)
    .set({
      ...extra,
      ...relayOwnerPatch(now),
      lastHeartbeatAt: now,
      updatedAt: now,
    })
    .where(eq(tunnelConnections.tunnelId, tunnelId));
}

export async function clearTunnelRelayOwnerIfCurrent(
  tunnelId: string,
  extra: Partial<typeof tunnelConnections.$inferInsert> = {},
) {
  await db
    .update(tunnelConnections)
    .set({
      ...extra,
      relayOwnerId: null,
      relayOwnerInstance: null,
      relayOwnerStartedAt: null,
      relayOwnerHeartbeatAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tunnelConnections.tunnelId, tunnelId),
        eq(tunnelConnections.relayOwnerId, API_INSTANCE_ID),
      ),
    );
}

export async function relayRpcToConnectedAgent(input: {
  tunnelId: string;
  accountId: string;
  method: string;
  params: Record<string, unknown>;
  /** Defaults to TUNNEL_RPC_TIMEOUT_MS. Longer while the machine may hold the call for its owner. */
  timeoutMs?: number;
}): Promise<unknown> {
  const [row] = await db
    .select()
    .from(tunnelConnections)
    .where(
      and(
        eq(tunnelConnections.tunnelId, input.tunnelId),
        eq(tunnelConnections.accountId, input.accountId),
      ),
    )
    .limit(1);

  if (!row?.setupTokenHash) {
    tunnelRelay.disconnectAgent(input.tunnelId, 4003, 'device credential revoked');
    throw new TunnelRelayError(
      TunnelErrorCode.AUTH_FAILED,
      `Tunnel agent ${input.tunnelId} credential is no longer valid`,
    );
  }

  if (tunnelRelay.isConnected(input.tunnelId)) {
    const metadata = tunnelRelay.getAgentMetadata(input.tunnelId);
    const connectedAccountId = metadata?.accountId;
    if (connectedAccountId !== input.accountId) {
      throw new TunnelRelayError(
        TunnelErrorCode.AUTH_FAILED,
        `Tunnel agent ${input.tunnelId} ownership does not match the RPC target`,
      );
    }
    if (metadata?.credentialFingerprint !== fingerprintTunnelCredentialHash(row.setupTokenHash)) {
      tunnelRelay.disconnectAgent(input.tunnelId, 4003, 'device credential rotated');
      throw new TunnelRelayError(
        TunnelErrorCode.AUTH_FAILED,
        `Tunnel agent ${input.tunnelId} credential was rotated`,
      );
    }
    const capability = capabilityForMethod(input.method);
    if (
      capability &&
      Array.isArray(metadata?.capabilities) &&
      !metadata.capabilities.includes(capability)
    ) {
      throw new TunnelRelayError(
        TunnelErrorCode.CAPABILITY_NOT_REGISTERED,
        `Capability is not registered by the connected Agent Tunnel: ${capability}`,
      );
    }
    return tunnelRelay.relayRPC(input.tunnelId, input.method, input.params, {
      timeoutMs: rpcTimeoutMs(input.timeoutMs),
    });
  }

  if (!isTunnelConnectionLive(row)) {
    throw new TunnelRelayError(
      TunnelErrorCode.NOT_CONNECTED,
      `Tunnel agent ${input.tunnelId} is not connected`,
    );
  }

  const ownerId = row.relayOwnerId;
  if (!ownerId) {
    throw new TunnelRelayError(
      TunnelErrorCode.NOT_CONNECTED,
      `Tunnel agent ${input.tunnelId} has no relay owner`,
    );
  }

  if (ownerId === API_INSTANCE_ID) {
    await clearTunnelRelayOwnerIfCurrent(input.tunnelId, { status: 'offline' });
    throw new TunnelRelayError(
      TunnelErrorCode.NOT_CONNECTED,
      `Tunnel agent ${input.tunnelId} is not connected on this API replica`,
    );
  }

  return forwardRpcToOwner({
    ...input,
    targetRelayOwnerId: ownerId,
  });
}

async function forwardRpcToOwner(input: {
  tunnelId: string;
  accountId: string;
  method: string;
  params: Record<string, unknown>;
  targetRelayOwnerId: string;
  timeoutMs?: number;
}): Promise<unknown> {
  // The owner replica reads the budget back from expires_at.
  const timeoutMs = rpcTimeoutMs(input.timeoutMs);
  const expiresAt = new Date(Date.now() + timeoutMs + FORWARD_TTL_PAD_MS);
  const [request] = await db
    .insert(tunnelRpcForwards)
    .values({
      tunnelId: input.tunnelId,
      accountId: input.accountId,
      requesterRelayOwnerId: API_INSTANCE_ID,
      targetRelayOwnerId: input.targetRelayOwnerId,
      method: input.method,
      params: input.params,
      expiresAt,
    })
    .returning({
      requestId: tunnelRpcForwards.requestId,
      // Wakes the owner's forwarder in the statement that queues the row. The
      // payload is the owner's instance id only.
      woke: sql`pg_notify(${TUNNEL_FORWARD_CHANNEL}, ${input.targetRelayOwnerId})`,
    });

  if (!request) {
    throw new TunnelRelayError(TunnelErrorCode.LOCAL_ERROR, 'Failed to queue tunnel RPC forward');
  }

  const deadline = Date.now() + timeoutMs + FORWARD_TTL_PAD_MS;
  let notified = false;
  let wake = () => {};
  resultWaiters.set(request.requestId, () => {
    notified = true;
    wake();
  });
  try {
    while (Date.now() < deadline) {
      notified = false;
      const [row] = await db
        .select()
        .from(tunnelRpcForwards)
        .where(eq(tunnelRpcForwards.requestId, request.requestId))
        .limit(1);

      if (!row) {
        throw new TunnelRelayError(TunnelErrorCode.LOCAL_ERROR, 'Tunnel RPC forward disappeared');
      }
      if (row.status === 'completed') {
        await deleteForwardBestEffort(request.requestId);
        return row.result;
      }
      if (row.status === 'error') {
        await deleteForwardBestEffort(request.requestId);
        const error = row.error ?? {};
        throw new TunnelRelayError(
          typeof error.code === 'number' ? error.code : TunnelErrorCode.LOCAL_ERROR,
          typeof error.message === 'string' ? error.message : 'Tunnel RPC forward failed',
          error.data,
        );
      }

      // A NOTIFY that arrived during the read above skips the wait: the read
      // may predate the result.
      if (notified) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, forwardPollMs(FORWARD_RESULT_FALLBACK_MS));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } finally {
    resultWaiters.delete(request.requestId);
  }

  await db.delete(tunnelRpcForwards).where(eq(tunnelRpcForwards.requestId, request.requestId));

  throw new TunnelRelayError(
    TunnelErrorCode.TIMEOUT,
    `RPC timeout after ${timeoutMs}ms for ${input.method}`,
  );
}

export function startTunnelRpcForwarder(): void {
  if (!forwarderStopped) return;
  forwarderStopped = false;
  scheduleForwarder(0);
}

export function stopTunnelRpcForwarder(): void {
  forwarderStopped = true;
  if (forwarderTimer) {
    clearTimeout(forwarderTimer);
    forwarderTimer = null;
  }
}

function scheduleForwarder(delayMs: number): void {
  if (forwarderStopped) return;
  // One pending timer at most: a wake replaces the idle timer, never adds one.
  if (forwarderTimer) clearTimeout(forwarderTimer);
  forwarderTimer = setTimeout(() => {
    void runWorkerTick('tunnel-rpc-forwarder', runForwarderTick);
  }, delayMs);
  forwarderTimer.unref?.();
}

function wakeForwarder(): void {
  // Mid-tick, the claim may predate the new row: run one more tick after it.
  if (forwarderRunning) forwarderWoken = true;
  else scheduleForwarder(0);
}

async function runForwarderTick(): Promise<void> {
  if (forwarderRunning || forwarderStopped) return;
  forwarderRunning = true;
  forwarderWoken = false;
  try {
    const rows = await claimPendingForwards();
    await Promise.all(rows.map(processForward));
    if (Date.now() - lastExpirySweepAt >= FORWARD_EXPIRY_SWEEP_MS) {
      lastExpirySweepAt = Date.now();
      await expireOldForwards();
    }
    scheduleForwarder(
      rows.length > 0 || forwarderWoken ? 0 : forwardPollMs(FORWARDER_FALLBACK_MS),
    );
  } catch (err) {
    console.warn('[tunnel-forwarder] tick failed:', err instanceof Error ? err.message : err);
    scheduleForwarder(FORWARDER_ERROR_MS);
  } finally {
    forwarderRunning = false;
  }
}

async function claimPendingForwards(): Promise<ForwardRow[]> {
  const rows = await db.execute<ForwardRow>(sql`
    WITH picked AS (
      SELECT request_id
      FROM kortix.tunnel_rpc_forwards
      WHERE target_relay_owner_id = ${API_INSTANCE_ID}
        AND status = 'pending'
        AND expires_at > now()
      ORDER BY created_at ASC
      LIMIT ${FORWARD_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE kortix.tunnel_rpc_forwards f
    SET status = 'processing', updated_at = now()
    FROM picked
    WHERE f.request_id = picked.request_id
    RETURNING
      f.request_id AS "requestId",
      f.tunnel_id AS "tunnelId",
      f.account_id AS "accountId",
      f.requester_relay_owner_id AS "requesterRelayOwnerId",
      f.target_relay_owner_id AS "targetRelayOwnerId",
      f.status,
      f.method,
      f.params,
      f.result,
      f.error,
      f.created_at AS "createdAt",
      f.updated_at AS "updatedAt",
      f.completed_at AS "completedAt",
      f.expires_at AS "expiresAt"
  `);
  return Array.from(rows as unknown as ForwardRow[]);
}

async function processForward(row: ForwardRow): Promise<void> {
  try {
    if (!tunnelRelay.isConnected(row.tunnelId)) {
      throw new TunnelRelayError(
        TunnelErrorCode.NOT_CONNECTED,
        `Tunnel agent ${row.tunnelId} is not connected on relay owner`,
      );
    }
    const metadata = tunnelRelay.getAgentMetadata(row.tunnelId);
    const connectedAccountId = metadata?.accountId;
    if (connectedAccountId !== row.accountId) {
      throw new TunnelRelayError(
        TunnelErrorCode.AUTH_FAILED,
        `Tunnel agent ${row.tunnelId} ownership does not match the forwarded RPC`,
      );
    }
    const [connection] = await db
      .select({ setupTokenHash: tunnelConnections.setupTokenHash })
      .from(tunnelConnections)
      .where(
        and(
          eq(tunnelConnections.tunnelId, row.tunnelId),
          eq(tunnelConnections.accountId, row.accountId),
        ),
      )
      .limit(1);
    if (
      !connection?.setupTokenHash ||
      metadata?.credentialFingerprint !== fingerprintTunnelCredentialHash(connection.setupTokenHash)
    ) {
      tunnelRelay.disconnectAgent(row.tunnelId, 4003, 'device credential revoked');
      throw new TunnelRelayError(
        TunnelErrorCode.AUTH_FAILED,
        `Tunnel agent ${row.tunnelId} credential is no longer valid`,
      );
    }
    const capability = capabilityForMethod(row.method);
    if (
      capability &&
      Array.isArray(metadata?.capabilities) &&
      !metadata.capabilities.includes(capability)
    ) {
      throw new TunnelRelayError(
        TunnelErrorCode.CAPABILITY_NOT_REGISTERED,
        `Capability is not registered by the connected Agent Tunnel: ${capability}`,
      );
    }
    const result = await tunnelRelay.relayRPC(row.tunnelId, row.method, row.params ?? {}, {
      timeoutMs: Math.max(1_000, new Date(row.expiresAt).getTime() - Date.now() - FORWARD_TTL_PAD_MS),
    });
    await finishForward(row.requestId, { status: 'completed', result });
  } catch (err) {
    const code = err instanceof TunnelRelayError ? err.code : TunnelErrorCode.LOCAL_ERROR;
    const message = err instanceof Error ? err.message : String(err);
    const data = err instanceof TunnelRelayError ? err.data : undefined;
    await finishForward(row.requestId, { status: 'error', error: { code, message, data } });
  }
}

async function finishForward(
  requestId: string,
  outcome: Pick<typeof tunnelRpcForwards.$inferInsert, 'status' | 'result' | 'error'>,
): Promise<void> {
  await db
    .update(tunnelRpcForwards)
    .set({ ...outcome, updatedAt: new Date(), completedAt: new Date() })
    .where(eq(tunnelRpcForwards.requestId, requestId))
    // Wakes the requester in the statement that writes its result. The payload
    // is the request id only.
    .returning({ woke: sql`pg_notify(${TUNNEL_FORWARD_CHANNEL}, ${requestId})` });
}

async function expireOldForwards(): Promise<void> {
  // Forward rows contain raw RPC parameters and results. They are transport,
  // not an audit ledger. Remove abandoned rows within FORWARD_EXPIRY_SWEEP_MS
  // of their short relay window closing instead of retaining file contents or
  // shell output.
  await db.delete(tunnelRpcForwards).where(lt(tunnelRpcForwards.expiresAt, new Date()));
}

async function deleteForwardBestEffort(requestId: string): Promise<void> {
  try {
    await db.delete(tunnelRpcForwards).where(eq(tunnelRpcForwards.requestId, requestId));
  } catch (error) {
    // The remote action already completed. Do not turn a transport-cleanup
    // failure into a caller retry. The expiry sweep remains the backstop.
    console.error(
      '[tunnel-forwarder] failed to delete consumed forward',
      requestId,
      error instanceof Error ? error.message : error,
    );
  }
}
