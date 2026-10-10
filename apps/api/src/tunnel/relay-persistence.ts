// Tunnel relay persistence: the relay events that write a machine's state to
// `tunnel_connections`. startTunnelService registers the handlers once per
// process (workers/tunnel-worker.ts).

import { isTunnelCapability } from 'agent-tunnel';
import { and, eq, sql } from 'drizzle-orm';
import { tunnelConnections, tunnelPermissions } from '@kortix/db';
import { fingerprintTunnelCredentialHash } from '../shared/crypto';
import { db } from '../shared/db';
import { clearTunnelRelayOwnerIfCurrent, markTunnelRelayOwner } from './core/cluster-forwarder';
import { tunnelRelay } from './core/relay';
import { retireSupersededRegistrations } from './registrations';

export function effectiveRegisteredCapabilities(
  reported: unknown,
  approved: unknown,
): string[] | null {
  if (
    !Array.isArray(reported) ||
    reported.length > 3 ||
    new Set(reported).size !== reported.length ||
    !reported.every(
      (capability) => typeof capability === 'string' && isTunnelCapability(capability),
    )
  ) {
    return null;
  }
  const approvedSet = new Set(
    Array.isArray(approved)
      ? approved.filter(
          (capability): capability is string =>
            typeof capability === 'string' && isTunnelCapability(capability),
        )
      : [],
  );
  return reported.filter((capability) => approvedSet.has(capability));
}

/** A merge into `machine_info` that never drops keys written concurrently. */
function mergeMachineInfo(patch: Record<string, unknown>, drop: string[] = []) {
  const base = drop.reduce(
    (current, key) => sql`${current} - ${key}::text`,
    sql`coalesce(${tunnelConnections.machineInfo}, '{}'::jsonb)`,
  );
  return sql`${base} || ${JSON.stringify(patch)}::jsonb`;
}

/**
 * v2 X2: the agent's access mode (`tunnel.access.state`, signed), stored at
 * `machine_info.access`. Null for anything malformed; old agents never send it.
 */
export function parseAccessState(
  params: unknown,
): { mode: 'ask' | 'always' | 'off'; grantedUntil: string | null } | null {
  if (!params || typeof params !== 'object') return null;
  const { mode, grantedUntil } = params as Record<string, unknown>;
  if (mode !== 'ask' && mode !== 'always' && mode !== 'off') return null;
  if (grantedUntil === null || grantedUntil === undefined) return { mode, grantedUntil: null };
  if (typeof grantedUntil !== 'string' || grantedUntil.length > 64) return null;
  const at = new Date(grantedUntil);
  return Number.isNaN(at.getTime()) ? null : { mode, grantedUntil: at.toISOString() };
}

/**
 * Agents up to 0.1.2 still narrow a desktop grant by its legacy `features`
 * list, and refuse every driver tool missing from their own map. Desktop is
 * one grant, so the agent receives it without that list.
 */
function wireScope(capability: string, scope: unknown): unknown {
  if (capability !== 'desktop' || !scope || typeof scope !== 'object') return scope;
  const { features: _legacy, ...rest } = scope as Record<string, unknown>;
  return rest;
}

async function syncActiveTunnelPermissions(
  tunnelId: string,
  capabilities: readonly string[],
): Promise<void> {
  const activePermissions = await db
    .select({
      permissionId: tunnelPermissions.permissionId,
      capability: tunnelPermissions.capability,
      scope: tunnelPermissions.scope,
      expiresAt: tunnelPermissions.expiresAt,
    })
    .from(tunnelPermissions)
    .where(and(eq(tunnelPermissions.tunnelId, tunnelId), eq(tunnelPermissions.status, 'active')));

  tunnelRelay.sendNotification(tunnelId, 'tunnel.permissions.sync', {
    permissions: activePermissions
      .filter((permission) => capabilities.includes(permission.capability))
      .map((permission) => ({
        permissionId: permission.permissionId,
        capability: permission.capability,
        scope: wireScope(permission.capability, permission.scope),
        expiresAt: permission.expiresAt?.toISOString() ?? undefined,
      })),
  });
}

export function registerTunnelRelayPersistence(): void {
  tunnelRelay.on('agent:connect', async ({ tunnelId, metadata }) => {
    const capabilities = Array.isArray(metadata?.capabilities)
      ? (metadata.capabilities as string[])
      : [];
    const machineInfo =
      metadata?.machineInfo && typeof metadata.machineInfo === 'object'
        ? (metadata.machineInfo as Record<string, unknown>)
        : {};

    try {
      // `access` is the agent's own report (tunnel.access.state), which may
      // land before this write; the auth-time snapshot must not replace it.
      // An agent that never reports it (npm 0.1.x) enforces no access mode,
      // so a mode stored by an earlier agent is dropped, not shown as live.
      const { access: _staleAccess, ...snapshot } = machineInfo;
      await markTunnelRelayOwner(tunnelId, {
        status: 'online',
        machineInfo: mergeMachineInfo(
          {
            ...snapshot,
            registeredCapabilities: capabilities,
            ...(typeof metadata?.agentVersion === 'string'
              ? { agentVersion: metadata.agentVersion }
              : {}),
          },
          metadata?.reportsAccess === true ? [] : ['access'],
        ) as unknown as Record<string, unknown>,
      });

      await syncActiveTunnelPermissions(tunnelId, capabilities);
    } catch (err) {
      console.warn(`[tunnel] Permission sync failed:`, err);
    }
  });

  tunnelRelay.on('agent:disconnect', async ({ tunnelId }) => {
    try {
      await clearTunnelRelayOwnerIfCurrent(tunnelId, { status: 'offline' });
    } catch {}
  });

  tunnelRelay.on('message:pong', async ({ tunnelId, params }) => {
    try {
      const metadata = tunnelRelay.getAgentMetadata(tunnelId);
      const [connection] = await db
        .select({
          setupTokenHash: tunnelConnections.setupTokenHash,
          capabilities: tunnelConnections.capabilities,
          machineInfo: tunnelConnections.machineInfo,
        })
        .from(tunnelConnections)
        .where(eq(tunnelConnections.tunnelId, tunnelId))
        .limit(1);
      if (
        !connection?.setupTokenHash ||
        metadata?.credentialFingerprint !==
          fingerprintTunnelCredentialHash(connection.setupTokenHash)
      ) {
        tunnelRelay.disconnectAgent(tunnelId, 4003, 'device credential revoked');
        return;
      }

      const capabilities = effectiveRegisteredCapabilities(
        params?.capabilities ?? [],
        connection.capabilities,
      );
      if (!capabilities) {
        tunnelRelay.disconnectAgent(tunnelId, 4003, 'invalid capability registration');
        return;
      }
      const previousCapabilities = Array.isArray(metadata?.capabilities)
        ? metadata.capabilities
        : [];
      tunnelRelay.updateAgentMetadata(tunnelId, { capabilities });

      markTunnelRelayOwner(tunnelId, { status: 'online' }).catch((err) =>
        console.warn(`[tunnel-heartbeat] DB update failed for ${tunnelId}:`, err),
      );

      const mi =
        params?.machineInfo && typeof params.machineInfo === 'object'
          ? (params.machineInfo as Record<string, unknown>)
          : {};
      const { access: _reportedElsewhere, ...reported } = mi;
      await db
        .update(tunnelConnections)
        .set({
          machineInfo: mergeMachineInfo({ ...reported, registeredCapabilities: capabilities }),
          status: 'online',
          updatedAt: new Date(),
        })
        .where(eq(tunnelConnections.tunnelId, tunnelId));

      // The first heartbeat that names the hardware supersedes the owner's
      // offline registrations of the same machine (one machine, one entry).
      const machineId = typeof reported.machineId === 'string' ? reported.machineId : '';
      const knownId = (connection.machineInfo as Record<string, unknown> | null)?.machineId;
      if (/^[a-f0-9]{64}$/.test(machineId) && knownId !== machineId) {
        await retireSupersededRegistrations(tunnelId, machineId);
      }

      if (
        previousCapabilities.length !== capabilities.length ||
        capabilities.some((capability) => !previousCapabilities.includes(capability))
      ) {
        await syncActiveTunnelPermissions(tunnelId, capabilities);
      }
    } catch (error) {
      console.warn(`[tunnel-heartbeat] Capability update failed for ${tunnelId}:`, error);
    }
  });

  tunnelRelay.on('message:raw', async ({ tunnelId, message }) => {
    const msg = message as { method?: unknown; params?: unknown };
    if (msg.method !== 'tunnel.access.state') return;
    const access = parseAccessState(msg.params);
    if (!access) return;
    try {
      await db
        .update(tunnelConnections)
        .set({ machineInfo: mergeMachineInfo({ access }), updatedAt: new Date() })
        .where(eq(tunnelConnections.tunnelId, tunnelId));
    } catch (error) {
      console.warn(`[tunnel] access state update failed for ${tunnelId}:`, error);
    }
  });

  tunnelRelay.on('agent:timeout', async ({ tunnelId }) => {
    console.warn(`[tunnel] Agent ${tunnelId} timed out — marking offline`);
    try {
      await clearTunnelRelayOwnerIfCurrent(tunnelId, { status: 'offline' });
    } catch (err) {
      console.error(`[tunnel] Failed to mark ${tunnelId} offline:`, err);
    }
  });
}
