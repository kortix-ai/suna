/**
 * Tunnel Connections Routes — the caller's paired machines.
 *
 * GET    /connections                      — machines the caller owns (+ owner-less team machines for managers)
 * GET    /connections/:tunnelId            — get one machine
 * PATCH  /connections/:tunnelId            — rename a machine
 * DELETE /connections/:tunnelId            — unpair: delete the machine, revoke its computer accounts
 * POST   /connections/:tunnelId/rotate-token — rotate the setup token
 *
 * Pairing is device auth only (`device-auth.ts`). Capabilities are fixed at
 * pairing; re-pair to change them.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { eq, and, desc, isNull, ne } from 'drizzle-orm';
import { connectorConnections, tunnelConnections } from '@kortix/db';
import { db } from '../../lib/db';
import { tunnelRelay } from '../../services/tunnel/core/relay';
import {
  generateTunnelToken,
  hashSecretKey,
  isTunnelToken,
  verifySecretKey,
} from '../../lib/crypto';
import { requestClientKey } from '../lib/client-ip';
import { isUuid } from '../../lib/validate';
import { tunnelRateLimiter } from '../../services/tunnel/core/rate-limiter';
import type { AppEnv } from '../../types/app-env';
import { makeOpenApiApp, json, errors } from '../openapi';
import { getTunnelOwnerContext, getTunnelReadContext } from './auth';
import { isTunnelConnectionLive } from '../../services/tunnel/core/cluster-forwarder';
import { effectiveMachineCapabilities } from '../../services/tunnel/core/rpc-core';
import { readJsonObject } from '../lib/http-body';
import { uniqueComputerLabel } from '../../services/connectors/computers';
import { unpairMachine } from '../../services/tunnel/registrations';
import { bearerToken } from '../lib/bearer';

export {
  retireStaleUnidentifiedRegistrations,
  retireSupersededRegistrations,
  UNIDENTIFIED_RETENTION_DAYS,
  unpairMachine,
} from '../../services/tunnel/registrations';

/** Permissive connection row shape, as persisted + serialized. */
const ConnectionSchema = z.record(z.string(), z.any());

/**
 * Explicit column selection for reads/returns — deliberately EXCLUDES
 * setupTokenHash (a scrypt hash of the one-time setup token) so it never
 * leaks into list/get/update responses.
 */
const SAFE_CONNECTION_COLUMNS = {
  tunnelId: tunnelConnections.tunnelId,
  accountId: tunnelConnections.accountId,
  ownerUserId: tunnelConnections.ownerUserId,
  sandboxId: tunnelConnections.sandboxId,
  name: tunnelConnections.name,
  status: tunnelConnections.status,
  capabilities: tunnelConnections.capabilities,
  machineInfo: tunnelConnections.machineInfo,
  relayOwnerId: tunnelConnections.relayOwnerId,
  relayOwnerInstance: tunnelConnections.relayOwnerInstance,
  relayOwnerStartedAt: tunnelConnections.relayOwnerStartedAt,
  relayOwnerHeartbeatAt: tunnelConnections.relayOwnerHeartbeatAt,
  lastHeartbeatAt: tunnelConnections.lastHeartbeatAt,
  createdAt: tunnelConnections.createdAt,
  updatedAt: tunnelConnections.updatedAt,
};

function serializeConnection(conn: Omit<typeof tunnelConnections.$inferSelect, 'setupTokenHash'>) {
  const isLive = isTunnelConnectionLive(conn);
  return {
    ...conn,
    approvedCapabilities: Array.isArray(conn.capabilities) ? conn.capabilities : [],
    capabilities: effectiveMachineCapabilities(conn),
    status: isLive ? 'online' : 'offline',
    isLive,
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A computer account's label follows its machine's name, deduped per owner. */
async function relabelComputerAccounts(tx: Tx, tunnelId: string, name: string): Promise<void> {
  const accounts = await tx
    .select()
    .from(connectorConnections)
    .where(eq(connectorConnections.tunnelId, tunnelId));
  for (const account of accounts) {
    const siblings = await tx
      .select({ label: connectorConnections.label })
      .from(connectorConnections)
      .where(
        and(
          eq(connectorConnections.connectorId, account.connectorId),
          eq(connectorConnections.ownerType, account.ownerType),
          account.ownerId === null
            ? isNull(connectorConnections.ownerId)
            : eq(connectorConnections.ownerId, account.ownerId),
          ne(connectorConnections.connectionId, account.connectionId),
        ),
      );
    const label = uniqueComputerLabel(name, new Set(siblings.map((row) => row.label)));
    if (label === account.label) continue;
    await tx
      .update(connectorConnections)
      .set({ label, updatedAt: new Date() })
      .where(eq(connectorConnections.connectionId, account.connectionId));
  }
}

export function createConnectionsRouter() {
  const router = makeOpenApiApp<AppEnv>();

  router.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['tunnel'],
      summary: "List the caller's paired machines",
      description:
        'Machines the caller paired, plus the account\'s owner-less team machines for account managers. Projects reach machines through computer accounts on the `computer` connector.',
      security: [{ bearerAuth: [] }],
      responses: {
        200: json(z.array(ConnectionSchema), 'Tunnel connections (each with an isLive flag)'),
        ...errors(401, 403),
      },
    }),
    async (c: any) => {
      const { ownerClause } = await getTunnelReadContext(c);

      const connections = await db
        .select(SAFE_CONNECTION_COLUMNS)
        .from(tunnelConnections)
        .where(ownerClause)
        .orderBy(desc(tunnelConnections.createdAt));

      const enriched = connections.map(serializeConnection);

      return c.json(enriched);
    },
  );

  router.openapi(
    createRoute({
      method: 'get',
      path: '/{tunnelId}',
      tags: ['tunnel'],
      summary: 'Get a single tunnel connection',
      security: [{ bearerAuth: [] }],
      request: { params: z.object({ tunnelId: z.string() }) },
      responses: {
        200: json(ConnectionSchema, 'The connection (with an isLive flag)'),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      const { ownerClause } = await getTunnelReadContext(c);
      const tunnelId = c.req.param('tunnelId');

      const [connection] = await db
        .select(SAFE_CONNECTION_COLUMNS)
        .from(tunnelConnections)
        .where(and(eq(tunnelConnections.tunnelId, tunnelId), ownerClause));

      if (!connection) {
        return c.json({ error: 'Tunnel connection not found' }, 404);
      }

      return c.json(serializeConnection(connection));
    },
  );

  router.openapi(
    createRoute({
      method: 'patch',
      path: '/{tunnelId}',
      tags: ['tunnel'],
      summary: 'Rename a paired machine',
      security: [{ bearerAuth: [] }],
      request: {
        params: z.object({ tunnelId: z.string() }),
        body: {
          content: {
            'application/json': {
              schema: z.object({ name: z.string() }),
            },
          },
        },
      },
      responses: {
        200: json(ConnectionSchema, 'The updated connection'),
        ...errors(400, 401, 403, 404),
      },
    }),
    async (c: any) => {
      const { ownerClause } = await getTunnelOwnerContext(c);
      const tunnelId = c.req.param('tunnelId');
      const body = await readJsonObject(c);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 255) {
        return c.json({ error: 'name must be a non-empty string of at most 255 characters' }, 400);
      }

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(tunnelConnections)
          .set({ name, updatedAt: new Date() })
          .where(and(eq(tunnelConnections.tunnelId, tunnelId), ownerClause))
          .returning(SAFE_CONNECTION_COLUMNS);
        if (row) await relabelComputerAccounts(tx, tunnelId, name);
        return row;
      });
      if (!updated) return c.json({ error: 'Tunnel connection not found' }, 404);
      return c.json(serializeConnection(updated));
    },
  );

  router.openapi(
    createRoute({
      method: 'post',
      path: '/{tunnelId}/rotate-token',
      tags: ['tunnel'],
      summary: 'Rotate the setup token for a tunnel connection',
      security: [{ bearerAuth: [] }],
      request: { params: z.object({ tunnelId: z.string() }) },
      responses: {
        200: json(
          z.object({ tunnelId: z.string(), setupToken: z.string() }),
          'The new one-time setup token',
        ),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      const { ownerClause } = await getTunnelOwnerContext(c);
      const tunnelId = c.req.param('tunnelId');

      const [tunnel] = await db
        .select()
        .from(tunnelConnections)
        .where(and(eq(tunnelConnections.tunnelId, tunnelId), ownerClause));

      if (!tunnel) {
        return c.json({ error: 'Tunnel connection not found' }, 404);
      }

      const newToken = generateTunnelToken();
      const newTokenHash = hashSecretKey(newToken);

      const [rotated] = await db
        .update(tunnelConnections)
        .set({ setupTokenHash: newTokenHash, updatedAt: new Date() })
        .where(and(eq(tunnelConnections.tunnelId, tunnelId), ownerClause))
        .returning({ tunnelId: tunnelConnections.tunnelId });
      if (!rotated) return c.json({ error: 'Tunnel connection not found' }, 404);

      tunnelRelay.sendNotification(tunnelId, 'tunnel.token.rotated', {
        reason: 'Token rotated by owner',
      });
      tunnelRelay.disconnectAgent(tunnelId, 4003, 'setup token rotated');

      return c.json({ tunnelId, setupToken: newToken });
    },
  );

  router.openapi(
    createRoute({
      method: 'delete',
      path: '/{tunnelId}',
      tags: ['tunnel'],
      summary: 'Unpair a machine: delete it and revoke its computer accounts',
      security: [{ bearerAuth: [] }],
      request: { params: z.object({ tunnelId: z.string() }) },
      responses: {
        200: json(z.object({ success: z.boolean() }), 'Deletion result'),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      const { ownerClause } = await getTunnelOwnerContext(c);
      const tunnelId = c.req.param('tunnelId');

      if (!(await unpairMachine(tunnelId, ownerClause))) {
        return c.json({ error: 'Tunnel connection not found' }, 404);
      }
      return c.json({ success: true });
    },
  );

  return router;
}

/**
 * `DELETE /v1/tunnel/self` — a machine unpairs itself (v2 X4). Mounted before
 * user auth: the ONLY credential is the machine's own setup token
 * (`Authorization: Bearer kortix_tnl_…` + `X-Tunnel-Id`), verified exactly
 * like the WebSocket handshake. The agent's `logout` calls it before it clears
 * its local credential, so a local disconnect never leaves the machine and its
 * accounts live on the server.
 */
export function createTunnelSelfRouter() {
  const router = makeOpenApiApp<AppEnv>();
  router.openapi(
    createRoute({
      method: 'delete',
      path: '/',
      tags: ['tunnel'],
      summary: 'A machine unpairs itself with its own credential',
      description:
        "Deletes the calling machine and revokes its computer accounts, exactly like `DELETE /v1/tunnel/connections/{tunnelId}`. Authenticated only by the machine's setup token (`Authorization: Bearer kortix_tnl_…`) and `X-Tunnel-Id`. Rate-limited per client.",
      request: {
        headers: z.object({ 'x-tunnel-id': z.string().uuid() }),
      },
      responses: {
        200: json(z.object({ success: z.boolean() }), 'The machine was unpaired'),
        ...errors(400, 401, 429),
      },
    }),
    async (c: any) => {
      const limited = tunnelRateLimiter.check('selfUnpair', requestClientKey(c));
      if (!limited.allowed) {
        return c.json({ error: 'Too many requests', retryAfterMs: limited.retryAfterMs }, 429);
      }
      const tunnelId = c.req.header('x-tunnel-id') ?? '';
      const token = bearerToken(c.req.header('authorization'))?.trim() ?? '';
      if (!isUuid(tunnelId)) return c.json({ error: 'X-Tunnel-Id must be a UUID' }, 400);
      // Look the machine up before the costly verifier, as the WS handshake does.
      const [machine] = isTunnelToken(token)
        ? await db
            .select({ setupTokenHash: tunnelConnections.setupTokenHash })
            .from(tunnelConnections)
            .where(eq(tunnelConnections.tunnelId, tunnelId))
            .limit(1)
        : [];
      if (!machine?.setupTokenHash || !verifySecretKey(token, machine.setupTokenHash)) {
        return c.json({ error: 'Invalid machine credential' }, 401);
      }
      // A token rotated after the check above no longer matches this hash.
      const unpaired = await unpairMachine(
        tunnelId,
        eq(tunnelConnections.setupTokenHash, machine.setupTokenHash),
      );
      if (!unpaired) return c.json({ error: 'Invalid machine credential' }, 401);
      return c.json({ success: true });
    },
  );
  return router;
}
