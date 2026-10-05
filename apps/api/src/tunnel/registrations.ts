// Tunnel registrations: unpairing, retiring superseded or silent machines, and
// the periodic cleanup tick (workers/tunnel-worker.ts).

import { and, eq, inArray, isNotNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import { connectorConnections, connectors, tunnelConnections, tunnelDeviceAuthRequests } from '@kortix/db';
import { db } from '../shared/db';
import { retryOnDeadlock } from '../shared/error-cause';
import { isTunnelConnectionLive } from './core/cluster-forwarder';
import { tunnelRateLimiter } from './core/rate-limiter';
import { tunnelRelay } from './core/relay';

/**
 * Unpair one machine: revoke its computer accounts (and drop their default
 * pin) so no resolver picks an account that reaches nothing, delete it (the
 * foreign key then sets their tunnel_id NULL), and drop its live socket.
 * False when no machine matches `tunnelId` and `where`.
 *
 * Lock order: connector rows, then the machine row, the order
 * `attachComputerConnection` uses. The delete's SET NULL update re-checks each
 * account's connector with a key-share lock, so taking it last, behind the
 * machine row, deadlocked (40P01) against an attach that holds the connector
 * and waits for the machine. The connectors are locked first, sorted, in the
 * same statement the delete would lock them. A connector that gains an account
 * for this machine after the read is the one case left: the retry covers it.
 */
export async function unpairMachine(tunnelId: string, where?: SQL): Promise<boolean> {
  const deleted = await retryOnDeadlock(() =>
    db.transaction(async (tx) => {
      const held = await tx
        .selectDistinct({ connectorId: connectorConnections.connectorId })
        .from(connectorConnections)
        .where(eq(connectorConnections.tunnelId, tunnelId));
      if (held.length > 0) {
        await tx
          .select({ connectorId: connectors.connectorId })
          .from(connectors)
          .where(inArray(connectors.connectorId, held.map((row) => row.connectorId)))
          .orderBy(connectors.connectorId)
          .for('key share');
      }
      const [machine] = await tx
        .select({ tunnelId: tunnelConnections.tunnelId })
        .from(tunnelConnections)
        .where(and(eq(tunnelConnections.tunnelId, tunnelId), where))
        .for('update');
      if (!machine) return false;
      await tx
        .update(connectorConnections)
        .set({ status: 'revoked', isDefault: false, updatedAt: new Date() })
        .where(eq(connectorConnections.tunnelId, tunnelId));
      await tx.delete(tunnelConnections).where(eq(tunnelConnections.tunnelId, tunnelId));
      return true;
    }),
  );
  if (deleted) tunnelRelay.disconnectAgent(tunnelId, 4003, 'tunnel deleted');
  return deleted;
}

/**
 * One machine, one registration per person. Once a registration reports a
 * hardware id (at approval, or in its first heartbeat that carries one), the
 * owner's other registrations of the same hardware are superseded: each is
 * unpaired with its accounts. Only offline ones: two agents running on one
 * machine at once never cut each other off, and the next heartbeat after one
 * stops retires it. Another person's registration is never touched. Returns
 * the retired tunnel ids.
 */
export async function retireSupersededRegistrations(tunnelId: string, machineId: string): Promise<string[]> {
  const [self] = await db
    .select({ ownerUserId: tunnelConnections.ownerUserId })
    .from(tunnelConnections)
    .where(eq(tunnelConnections.tunnelId, tunnelId))
    .limit(1);
  if (!self?.ownerUserId) return [];
  const others = await db
    .select({
      tunnelId: tunnelConnections.tunnelId,
      status: tunnelConnections.status,
      lastHeartbeatAt: tunnelConnections.lastHeartbeatAt,
      relayOwnerId: tunnelConnections.relayOwnerId,
      relayOwnerHeartbeatAt: tunnelConnections.relayOwnerHeartbeatAt,
    })
    .from(tunnelConnections)
    .where(
      and(
        eq(tunnelConnections.ownerUserId, self.ownerUserId),
        sql`${tunnelConnections.machineInfo}->>'machineId' = ${machineId}`,
        ne(tunnelConnections.tunnelId, tunnelId),
      ),
    );
  const retired: string[] = [];
  for (const other of others) {
    if (isTunnelConnectionLive(other)) continue;
    if (await unpairMachine(other.tunnelId)) retired.push(other.tunnelId);
  }
  return retired;
}

/** A registration without a hardware id is removed after this long without a sign of life. */
export const UNIDENTIFIED_RETENTION_DAYS = 30;

/**
 * Registrations made by agents older than hardware ids cannot be matched to a
 * computer. Once one has shown no sign of life for 30 days (no heartbeat, no
 * update, no relay ownership), it is unpaired with its accounts. A computer
 * that comes back pairs again; its agent says how. Runs on the tunnel cleanup
 * tick, at most `limit` per run. Returns the removed tunnel ids.
 */
export async function retireStaleUnidentifiedRegistrations(limit = 100): Promise<string[]> {
  const stale = await db
    .select({ tunnelId: tunnelConnections.tunnelId })
    .from(tunnelConnections)
    .where(
      and(
        sql`${tunnelConnections.machineInfo}->>'machineId' is null`,
        sql`greatest(
          ${tunnelConnections.lastHeartbeatAt},
          ${tunnelConnections.relayOwnerHeartbeatAt},
          ${tunnelConnections.updatedAt},
          ${tunnelConnections.createdAt}
        ) < now() - make_interval(days => ${UNIDENTIFIED_RETENTION_DAYS})`,
      ),
    )
    .limit(limit);
  const retired: string[] = [];
  for (const { tunnelId } of stale) {
    if (await unpairMachine(tunnelId)) retired.push(tunnelId);
  }
  return retired;
}

/** One tunnel cleanup pass: rate-limiter buckets, silent unidentified registrations, device auth. */
export async function runTunnelCleanupOnce(): Promise<void> {
  try {
    tunnelRateLimiter.cleanup();

    const retired = await retireStaleUnidentifiedRegistrations();
    if (retired.length > 0) {
      console.log(
        `[tunnel-cleanup] removed ${retired.length} registration(s) without a hardware id, silent ${UNIDENTIFIED_RETENTION_DAYS}+ days`,
      );
    }

    // Expire pending device auth requests
    await db
      .update(tunnelDeviceAuthRequests)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(
        and(
          eq(tunnelDeviceAuthRequests.status, 'pending'),
          lt(tunnelDeviceAuthRequests.expiresAt, new Date()),
        ),
      );
    await db
      .update(tunnelDeviceAuthRequests)
      .set({ setupToken: null, updatedAt: new Date() })
      .where(
        and(
          lt(tunnelDeviceAuthRequests.expiresAt, new Date()),
          isNotNull(tunnelDeviceAuthRequests.setupToken),
        ),
      );
    // Device-auth rows are a short credential handoff, not an audit log.
    // Retain terminal metadata for one day for retry diagnostics, then remove
    // the secret hash, hostname, and account association.
    await db
      .delete(tunnelDeviceAuthRequests)
      .where(lt(tunnelDeviceAuthRequests.expiresAt, new Date(Date.now() - 24 * 60 * 60_000)));
  } catch (err) {
    console.warn('[TUNNEL] Cleanup error:', err);
  }
}
