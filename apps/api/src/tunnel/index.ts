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

import { createWsHandlers, type AuthResult } from 'agent-tunnel';
import { eq, and, lt } from 'drizzle-orm';
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
import { notifyTunnelEvent } from './routes/permission-requests';
// Static imports — these MUST NOT be dynamic `await import(...)`. Under
// `bun --hot` (local dev) a dynamic import inside the WS auth handler can wedge
// and never settle, so onAuthenticate hangs → the agent never gets `auth_ok`
// and the tunnel is stuck "offline" forever. See the prod-timeout incident note.
import { isTunnelToken, isKortixToken, hashSecretKey, deriveSigningKey } from '../shared/crypto';
import { validateSecretKey } from '../repositories/api-keys';
import { getSupabase } from '../shared/supabase';
import { db } from '../shared/db';

// ─── Hono Sub-App ────────────────────────────────────────────────────────────

const tunnelApp = makeOpenApiApp<AppEnv>();

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
  async onAuthenticate(tunnelId: string, token: string): Promise<AuthResult | null> {
    let accountId: string | null = null;
    let tunnel: any = null;

    if (isTunnelToken(token)) {
      const tokenHash = hashSecretKey(token);
      const [row] = await db
        .select()
        .from(tunnelConnections)
        .where(and(
          eq(tunnelConnections.tunnelId, tunnelId),
          eq(tunnelConnections.setupTokenHash, tokenHash),
        ));
      if (row) {
        accountId = row.accountId;
        tunnel = row;
      }
    } else if (isKortixToken(token)) {
      const result = await validateSecretKey(token);
      if (result.isValid) accountId = result.accountId!;
    } else {
      try {
        const supabase = getSupabase();
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (!error && user) accountId = user.id;
      } catch {}
    }

    if (!accountId) return null;

    if (!tunnel) {
      const [row] = await db
        .select()
        .from(tunnelConnections)
        .where(and(
          eq(tunnelConnections.tunnelId, tunnelId),
          eq(tunnelConnections.accountId, accountId),
        ));
      tunnel = row;
    }

    if (!tunnel) return null;

    const signingKey = deriveSigningKey(token, config.TUNNEL_SIGNING_SECRET);
    return {
      signingKey,
      metadata: {
        accountId,
        capabilities: tunnel.capabilities || [],
      },
    };
  },
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

let permissionCleanupInterval: ReturnType<typeof setInterval> | null = null;

function startTunnelService(): void {
  if (!config.TUNNEL_ENABLED) {
    console.log('[TUNNEL] Tunnel disabled (TUNNEL_ENABLED=false)');
    return;
  }

  heartbeatManager.start();

  // ── DB persistence via relay events ──────────────────────────────────

  tunnelRelay.on('agent:connect', async ({ tunnelId, metadata }) => {
    const accountId = metadata?.accountId as string | undefined;

    try {
      await db.update(tunnelConnections)
        .set({ status: 'online', lastHeartbeatAt: new Date(), updatedAt: new Date() })
        .where(eq(tunnelConnections.tunnelId, tunnelId));

      if (accountId) {
        notifyTunnelEvent(accountId, 'tunnel_connected', { tunnelId });
      }

      // Sync active permissions to the agent
      const activePerms = await db
        .select({
          permissionId: tunnelPermissions.permissionId,
          capability: tunnelPermissions.capability,
          scope: tunnelPermissions.scope,
          expiresAt: tunnelPermissions.expiresAt,
        })
        .from(tunnelPermissions)
        .where(
          and(
            eq(tunnelPermissions.tunnelId, tunnelId),
            eq(tunnelPermissions.status, 'active'),
          ),
        );

      tunnelRelay.sendNotification(tunnelId, 'tunnel.permissions.sync', {
        permissions: activePerms.map((p) => ({
          permissionId: p.permissionId,
          capability: p.capability,
          scope: p.scope,
          expiresAt: p.expiresAt?.toISOString() ?? undefined,
        })),
      });
    } catch (err) {
      console.warn(`[tunnel] Permission sync failed:`, err);
    }
  });

  tunnelRelay.on('agent:disconnect', async ({ tunnelId, metadata }) => {
    const accountId = metadata?.accountId as string | undefined;

    try {
      await db.update(tunnelConnections)
        .set({ status: 'offline', updatedAt: new Date() })
        .where(eq(tunnelConnections.tunnelId, tunnelId));

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
      db.update(tunnelConnections)
        .set({ lastHeartbeatAt: new Date(), updatedAt: new Date() })
        .where(eq(tunnelConnections.tunnelId, tunnelId))
        .catch((err) => console.warn(`[tunnel-heartbeat] DB update failed for ${tunnelId}:`, err));

      const mi = params?.machineInfo;
      if (mi && typeof mi === 'object' && (mi as any).hostname) {
        db.update(tunnelConnections)
          .set({ machineInfo: mi, updatedAt: new Date() })
          .where(eq(tunnelConnections.tunnelId, tunnelId))
          .catch(() => {});
      }
    } catch {}
  });

  tunnelRelay.on('agent:timeout', async ({ tunnelId }) => {
    console.warn(`[tunnel] Agent ${tunnelId} timed out — marking offline`);
    try {
      await db
        .update(tunnelConnections)
        .set({ status: 'offline', updatedAt: new Date() })
        .where(eq(tunnelConnections.tunnelId, tunnelId));
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
          and(
            eq(tunnelPermissions.status, 'active'),
            lt(tunnelPermissions.expiresAt, new Date()),
          ),
        );

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
  heartbeatManager.stop();
  tunnelRelay.shutdown();
  console.log('[TUNNEL] Tunnel service stopped');
}

function getTunnelServiceStatus(): { enabled: boolean; connectedAgents: number } {
  return {
    enabled: config.TUNNEL_ENABLED,
    connectedAgents: tunnelRelay.getConnectedCount(),
  };
}

export {
  tunnelApp,
  wsHandlers,
  startTunnelService,
  stopTunnelService,
  getTunnelServiceStatus,
};
