/**
 * Tunnel Sub-Service — reverse-tunnel infrastructure for connecting
 * cloud sandboxes to local machine resources.
 *
 * Uses the agent-tunnel library for transport (relay, heartbeat, WS handlers).
 * This file wires in Kortix-specific business logic: DB persistence,
 * permission sync, event notifications, and cleanup.
 *
 * Routes:
 *   /connections/*           — the caller's paired machines (list, rename, unpair)
 *   /device-auth/*           — pairing (device-code flow)
 *   /rpc/*                   — RPC relay (owner → local agent)
 *
 * Projects reach a machine through a computer account on the `computer`
 * connector (connectors/gateway.ts), never through these routes.
 */

import {
  createWsHandlers,
  isTunnelCapability,
  type AuthResult,
  type TunnelAuthMessage,
} from 'agent-tunnel';
import { randomBytes } from 'node:crypto';
import { bodyLimit } from 'hono/body-limit';
import { eq, and, isNotNull, lt, sql } from 'drizzle-orm';
import { tunnelConnections, tunnelPermissions, tunnelDeviceAuthRequests } from '@kortix/db';
import { config } from '../config';
import type { AppEnv } from '../types';
import { makeOpenApiApp } from '../openapi';
import { createConnectionsRouter } from './routes/connections';
import {
  retireStaleUnidentifiedRegistrations,
  retireSupersededRegistrations,
  UNIDENTIFIED_RETENTION_DAYS,
} from './connections-service';
import { createRpcRouter } from './routes/rpc';
import { createDeviceAuthRouter } from './routes/device-auth';
import { tunnelRelay } from './core/relay';
import { heartbeatManager } from './core/heartbeat';
import {
  clearTunnelRelayOwnerIfCurrent,
  markTunnelRelayOwner,
  startTunnelRpcForwarder,
  stopTunnelRpcForwarder,
} from './core/cluster-forwarder';
import { tunnelRateLimiter } from './core/rate-limiter';
// Static imports — these MUST NOT be dynamic `await import(...)`. Under
// `bun --hot` (local dev) a dynamic import inside the WS auth handler can wedge
// and never settle, so onAuthenticate hangs → the agent never gets `auth_ok`
// and the tunnel is stuck "offline" forever. See the prod-timeout incident note.
import { fingerprintTunnelCredentialHash, isTunnelToken, verifySecretKey } from '../shared/crypto';
import { db } from '../shared/db';
import { runWorkerTick } from '../shared/audit-scope';
import { type AuditEventInput, recordAuditEvent } from '../shared/audit';

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
tunnelApp.route('/rpc', createRpcRouter());
tunnelApp.route('/device-auth', createDeviceAuthRouter());

// ─── Handshake audit ─────────────────────────────────────────────────────────

type TunnelAgentAuthRefusal = 'not_a_tunnel_token' | 'bad_secret' | 'capabilities_rejected';

/**
 * The audit row for a tunnel agent's handshake. The machine's setup token
 * arrives in the first WebSocket message, outside any HTTP request, so no
 * request audit sees it; this authenticator records it itself. A refusal
 * proves nobody, so it is `anonymous` — but on the tunnel's account when the
 * tunnel exists, so its owner sees the attempt. Exported for tests.
 */
export function tunnelAgentAuthAuditEvent(input: {
  tunnelId: string;
  accountId: string | null;
  outcome: 'success' | 'denied';
  reason?: TunnelAgentAuthRefusal;
  credentialFingerprint?: string | null;
}): AuditEventInput {
  return {
    accountId: input.accountId,
    actorType: input.outcome === 'success' ? 'system' : 'anonymous',
    actorUserId: null,
    authoritativeSource: 'tunnel_agent',
    outcome: input.outcome,
    action: 'tunnel.agent.authenticate',
    resourceType: 'tunnel',
    resourceId: input.tunnelId,
    metadata: {
      auth: {
        kind: 'tunnel_setup_token',
        ...(input.credentialFingerprint
          ? { credential_fingerprint: input.credentialFingerprint }
          : {}),
      },
      ...(input.reason ? { reason: input.reason } : {}),
    },
  };
}

function recordTunnelAgentAuth(input: Parameters<typeof tunnelAgentAuthAuditEvent>[0]): void {
  void recordAuditEvent(tunnelAgentAuthAuditEvent(input)).catch((error) => {
    console.error('[tunnel] handshake audit failed:', error);
  });
}

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
    if (!isTunnelToken(token)) {
      recordTunnelAgentAuth({ tunnelId, accountId: null, outcome: 'denied', reason: 'not_a_tunnel_token' });
      return null;
    }
    const [tunnel] = await db
      .select()
      .from(tunnelConnections)
      .where(eq(tunnelConnections.tunnelId, tunnelId));
    // Resolve the untrusted tunnel id before running the intentionally costly
    // secret verifier. Random ids cannot become a synchronous scrypt DoS.
    if (!tunnel?.setupTokenHash || !verifySecretKey(token, tunnel.setupTokenHash)) {
      recordTunnelAgentAuth({
        tunnelId,
        accountId: tunnel?.accountId ?? null,
        outcome: 'denied',
        reason: 'bad_secret',
      });
      return null;
    }

    // The DB list is the browser-approved ceiling. The auth list is the exact
    // handler surface registered by this agent process. Intersect both so an
    // old or compromised client cannot advertise stale or extra capabilities.
    const capabilities = effectiveRegisteredCapabilities(
      auth.capabilities ?? [],
      tunnel.capabilities,
    );
    if (!capabilities) {
      recordTunnelAgentAuth({
        tunnelId,
        accountId: tunnel.accountId,
        outcome: 'denied',
        reason: 'capabilities_rejected',
      });
      return null;
    }
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
    const credentialFingerprint = fingerprintTunnelCredentialHash(tunnel.setupTokenHash);
    recordTunnelAgentAuth({
      tunnelId,
      accountId: tunnel.accountId,
      outcome: 'success',
      credentialFingerprint,
    });
    return {
      signingKey,
      metadata: {
        accountId: tunnel.accountId,
        capabilities,
        approvedCapabilities: tunnel.capabilities || [],
        agentVersion,
        reportsAccess: auth.reportsAccess === true,
        machineInfo: tunnel.machineInfo ?? {},
        credentialFingerprint,
      },
    };
  },
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

// Heartbeat liveness is transport state, not DB persistence state. Record the
// signed pong synchronously before the async capability/heartbeat DB handler
// runs below. Without this wiring, every healthy agent times out after three
// intervals even though its pongs update the connection row successfully.
tunnelRelay.on('message:pong', ({ tunnelId }) => {
  heartbeatManager.recordPong(tunnelId);
});

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

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

  // ── Rate-limiter + device-auth cleanup ───────────────────────────────

  cleanupInterval = setInterval(() => void runWorkerTick('tunnel-cleanup', async () => {
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
  }), 5 * 60_000);

  console.log('[TUNNEL] Tunnel service started');
}

function stopTunnelService(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
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
