/**
 * Tunnel Sub-Service — reverse-tunnel infrastructure for connecting
 * cloud sandboxes to local machine resources.
 *
 * Uses the agent-tunnel library for transport (relay, heartbeat, WS handlers).
 * This file wires in Kortix-specific business logic: DB persistence,
 * permission sync, event notifications, and cleanup.
 *
 * Routes:
 *   /connections/*           — CRUD for tunnel connections
 *   /permissions/*           — manage granted permissions
 *   /permission-requests/*   — real-time permission approval flow (incl. SSE)
 *   /rpc/*                   — RPC relay (sandbox → local agent)
 *   /audit/*                 — paginated audit logs
 */

import {
  createWsHandlers,
  isTunnelCapability,
  type AuthResult,
  type TunnelAuthMessage,
} from 'agent-tunnel';
import { randomBytes } from 'node:crypto';
import { bodyLimit } from 'hono/body-limit';
import { eq, and, isNotNull, lt } from 'drizzle-orm';
import { tunnelConnections, tunnelPermissions, tunnelDeviceAuthRequests } from '@kortix/db';
import { config } from '../config';
import type { AppEnv } from '../types';
import { makeOpenApiApp } from '../openapi';
import { createConnectionsRouter } from './routes/connections';
import { createPermissionsRouter } from './routes/permissions';
import { createPermissionRequestsRouter } from './routes/permission-requests';
import { createRpcRouter } from './routes/rpc';
import { createAuditRouter } from './routes/audit';
import { createDeviceAuthRouter } from './routes/device-auth';
import { tunnelRelay } from './core/relay';
import { heartbeatManager } from './core/heartbeat';
import {
  clearTunnelRelayOwnerIfCurrent,
  markTunnelRelayOwner,
  startTunnelRpcForwarder,
  stopTunnelRpcForwarder,
} from './core/cluster-forwarder';
import { notifyTunnelEvent } from './routes/permission-requests';
import { tunnelRateLimiter } from './core/rate-limiter';
// Static imports — these MUST NOT be dynamic `await import(...)`. Under
// `bun --hot` (local dev) a dynamic import inside the WS auth handler can wedge
// and never settle, so onAuthenticate hangs → the agent never gets `auth_ok`
// and the tunnel is stuck "offline" forever. See the prod-timeout incident note.
import { fingerprintTunnelCredentialHash, isTunnelToken, verifySecretKey } from '../shared/crypto';
import { db } from '../shared/db';
import { reconcileComputerConnectors } from '../connectors/sync';

// ─── Hono Sub-App ────────────────────────────────────────────────────────────

const tunnelApp = makeOpenApiApp<AppEnv>();

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

tunnelApp.use(
  '*',
  bodyLimit({
    maxSize: config.TUNNEL_MAX_WS_MESSAGE_SIZE,
    onError: (c) => c.json({ error: 'Tunnel request body is too large' }, 413),
  }),
);

tunnelApp.route('/connections', createConnectionsRouter());
tunnelApp.route('/permissions', createPermissionsRouter());
tunnelApp.route('/permission-requests', createPermissionRequestsRouter());
tunnelApp.route('/rpc', createRpcRouter());
tunnelApp.route('/audit', createAuditRouter());
tunnelApp.route('/device-auth', createDeviceAuthRouter());

// ─── WS Handlers (used by index.ts Bun server) ──────────────────────────────

const wsHandlers = createWsHandlers(tunnelRelay, {
  heartbeat: heartbeatManager,
  maxMessageSize: config.TUNNEL_MAX_WS_MESSAGE_SIZE,
  async onAuthenticate(
    tunnelId: string,
    token: string,
    auth: TunnelAuthMessage,
  ): Promise<AuthResult | null> {
    // Only the machine-specific setup token can become a tunnel agent.
    // User, PAT, service-account, and sandbox credentials are HTTP principals;
    // accepting them here lets those callers impersonate and replace a machine.
    if (!isTunnelToken(token)) return null;
    const [tunnel] = await db
      .select()
      .from(tunnelConnections)
      .where(eq(tunnelConnections.tunnelId, tunnelId));
    // Resolve the untrusted tunnel id before running the intentionally costly
    // secret verifier. Random ids cannot become a synchronous scrypt DoS.
    if (!tunnel?.setupTokenHash || !verifySecretKey(token, tunnel.setupTokenHash)) return null;

    // The DB list is the browser-approved ceiling. The auth list is the exact
    // handler surface registered by this agent process. Intersect both so an
    // old or compromised client cannot advertise stale or extra capabilities.
    const capabilities = effectiveRegisteredCapabilities(
      auth.capabilities ?? [],
      tunnel.capabilities,
    );
    if (!capabilities) return null;
    const agentVersion =
      typeof auth.agentVersion === 'string' &&
      auth.agentVersion.length <= 64 &&
      !/[\r\n]/.test(auth.agentVersion)
        ? auth.agentVersion
        : null;

    // A fresh key binds nonces and signatures to this TLS WebSocket session.
    // Reconnecting never reuses the HMAC key, so captured frames cannot replay
    // after a reconnect even when the long-lived setup token is unchanged.
    const signingKey = randomBytes(32).toString('hex');
    return {
      signingKey,
      metadata: {
        accountId: tunnel.accountId,
        capabilities,
        approvedCapabilities: tunnel.capabilities || [],
        agentVersion,
        machineInfo: tunnel.machineInfo ?? {},
        credentialFingerprint: fingerprintTunnelCredentialHash(tunnel.setupTokenHash),
      },
    };
  },
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

let permissionCleanupInterval: ReturnType<typeof setInterval> | null = null;

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
        scope: permission.scope,
        expiresAt: permission.expiresAt?.toISOString() ?? undefined,
      })),
  });
}

function startTunnelService(): void {
  if (!config.TUNNEL_ENABLED) {
    console.log('[TUNNEL] Tunnel disabled (TUNNEL_ENABLED=false)');
    return;
  }

  heartbeatManager.start();
  startTunnelRpcForwarder();

  // ── DB persistence via relay events ──────────────────────────────────

  tunnelRelay.on('agent:connect', async ({ tunnelId, metadata }) => {
    const accountId = metadata?.accountId as string | undefined;
    const capabilities = Array.isArray(metadata?.capabilities)
      ? (metadata.capabilities as string[])
      : [];
    const machineInfo =
      metadata?.machineInfo && typeof metadata.machineInfo === 'object'
        ? (metadata.machineInfo as Record<string, unknown>)
        : {};

    try {
      await markTunnelRelayOwner(tunnelId, {
        status: 'online',
        machineInfo: {
          ...machineInfo,
          registeredCapabilities: capabilities,
          ...(typeof metadata?.agentVersion === 'string'
            ? { agentVersion: metadata.agentVersion }
            : {}),
        },
      });

      if (accountId) {
        notifyTunnelEvent(accountId, 'tunnel_connected', { tunnelId });
        // The first real handshake is the materialization boundary. Device
        // approval creates an offline row before this point and must not expose
        // a connector for a machine that never connected.
        void reconcileComputerConnectors(accountId);
      }

      await syncActiveTunnelPermissions(tunnelId, capabilities);
    } catch (err) {
      console.warn(`[tunnel] Permission sync failed:`, err);
    }
  });

  tunnelRelay.on('agent:disconnect', async ({ tunnelId, metadata }) => {
    const accountId = metadata?.accountId as string | undefined;

    try {
      await clearTunnelRelayOwnerIfCurrent(tunnelId, { status: 'offline' });

      if (accountId) {
        notifyTunnelEvent(accountId, 'tunnel_disconnected', { tunnelId });
      }
    } catch {}
  });

  tunnelRelay.on('connection:replaced', ({ tunnelId }) => {
    const metadata = tunnelRelay.getAgentMetadata(tunnelId);
    const accountId = metadata?.accountId as string | undefined;
    if (accountId) {
      notifyTunnelEvent(accountId, 'connection_replaced', { tunnelId });
    }
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
      await db
        .update(tunnelConnections)
        .set({
          machineInfo: {
            ...((connection.machineInfo as Record<string, unknown> | null) ?? {}),
            ...mi,
            registeredCapabilities: capabilities,
          },
          status: 'online',
          updatedAt: new Date(),
        })
        .where(eq(tunnelConnections.tunnelId, tunnelId));

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

  tunnelRelay.on('agent:timeout', async ({ tunnelId }) => {
    console.warn(`[tunnel] Agent ${tunnelId} timed out — marking offline`);
    try {
      await clearTunnelRelayOwnerIfCurrent(tunnelId, { status: 'offline' });
    } catch (err) {
      console.error(`[tunnel] Failed to mark ${tunnelId} offline:`, err);
    }
  });

  // ── Permission expiry cleanup ────────────────────────────────────────

  permissionCleanupInterval = setInterval(async () => {
    try {
      await db
        .update(tunnelPermissions)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(
          and(eq(tunnelPermissions.status, 'active'), lt(tunnelPermissions.expiresAt, new Date())),
        );
      tunnelRateLimiter.cleanup();

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
      console.warn('[TUNNEL] Permission cleanup error:', err);
    }
  }, 5 * 60_000);

  console.log('[TUNNEL] Tunnel service started');
}

function stopTunnelService(): void {
  if (permissionCleanupInterval) {
    clearInterval(permissionCleanupInterval);
    permissionCleanupInterval = null;
  }
  stopTunnelRpcForwarder();
  heartbeatManager.stop();
  tunnelRelay.shutdown();
  console.log('[TUNNEL] Tunnel service stopped');
}

function getTunnelServiceStatus(): {
  enabled: boolean;
  connectedAgents: number;
} {
  return {
    enabled: config.TUNNEL_ENABLED,
    connectedAgents: tunnelRelay.getConnectedCount(),
  };
}

export { tunnelApp, wsHandlers, startTunnelService, stopTunnelService, getTunnelServiceStatus };
