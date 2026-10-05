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
  type AuthResult,
  type TunnelAuthMessage,
} from 'agent-tunnel';
import { randomBytes } from 'node:crypto';
import { bodyLimit } from 'hono/body-limit';
import { eq } from 'drizzle-orm';
import { tunnelConnections } from '@kortix/db';
import { config } from '../config';
import type { AppEnv } from '../types';
import { makeOpenApiApp } from '../openapi';
import { createConnectionsRouter } from './routes/connections';
import { createRpcRouter } from './routes/rpc';
import { createDeviceAuthRouter } from './routes/device-auth';
import { tunnelRelay } from './core/relay';
import { heartbeatManager } from './core/heartbeat';
import { effectiveRegisteredCapabilities } from './relay-persistence';
// Static imports — these MUST NOT be dynamic `await import(...)`. Under
// `bun --hot` (local dev) a dynamic import inside the WS auth handler can wedge
// and never settle, so onAuthenticate hangs → the agent never gets `auth_ok`
// and the tunnel is stuck "offline" forever. See the prod-timeout incident note.
import { fingerprintTunnelCredentialHash, isTunnelToken, verifySecretKey } from '../shared/crypto';
import { db } from '../shared/db';
import { type AuditEventInput, recordAuditEvent } from '../shared/audit';

// ─── Hono Sub-App ────────────────────────────────────────────────────────────

const tunnelApp = makeOpenApiApp<AppEnv>();

export { effectiveRegisteredCapabilities, parseAccessState } from './relay-persistence';

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
// in relay-persistence.ts runs. Without this wiring, every healthy agent times
// out after three intervals even though its pongs update the connection row
// successfully.
tunnelRelay.on('message:pong', ({ tunnelId }) => {
  heartbeatManager.recordPong(tunnelId);
});

function getTunnelServiceStatus(): {
  enabled: boolean;
  connectedAgents: number;
} {
  return {
    enabled: config.TUNNEL_ENABLED,
    connectedAgents: tunnelRelay.getConnectedCount(),
  };
}

export { startTunnelService, stopTunnelService } from '../workers/tunnel-worker';
export { tunnelApp, wsHandlers, getTunnelServiceStatus };
