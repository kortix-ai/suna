/**
 * Tunnel Connections Routes — CRUD for registered tunnel connections.
 *
 * GET    /connections                      — list connections for account
 * POST   /connections                      — register a new tunnel connection
 * GET    /connections/:tunnelId            — get a single connection
 * PATCH  /connections/:tunnelId            — update connection (name, capabilities)
 * DELETE /connections/:tunnelId            — delete connection and live permissions
 * POST   /connections/:tunnelId/rotate-token — rotate the setup token
 */

import { createRoute, z } from '@hono/zod-openapi';
import { eq, and, desc, notInArray } from 'drizzle-orm';
import { tunnelConnections, tunnelPermissions } from '@kortix/db';
import { db } from '../../shared/db';
import { tunnelRelay } from '../core/relay';
import { generateTunnelToken, hashSecretKey } from '../../shared/crypto';
import type { AppEnv } from '../../types';
import { makeOpenApiApp, json, errors } from '../../openapi';
import { getTunnelOwnerContext, getTunnelReadContext } from './auth';
import { reconcileComputerConnectors } from '../../connectors/sync';
import { isTunnelConnectionLive } from '../core/cluster-forwarder';
import { isValidCapability } from '../core/scope-validator';

function validCapabilities(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 3 &&
    new Set(value).size === value.length &&
    value.every((capability) => typeof capability === 'string' && isValidCapability(capability))
  );
}

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
  const approvedCapabilities = Array.isArray(conn.capabilities) ? conn.capabilities : [];
  const registeredCapabilities = (conn.machineInfo as Record<string, unknown> | null)
    ?.registeredCapabilities;
  const capabilities = Array.isArray(registeredCapabilities)
    ? approvedCapabilities.filter((capability) => registeredCapabilities.includes(capability))
    : approvedCapabilities;
  return {
    ...conn,
    approvedCapabilities,
    capabilities,
    status: isLive ? 'online' : 'offline',
    isLive,
  };
}

export function createConnectionsRouter() {
  const router = makeOpenApiApp<AppEnv>();

  router.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['tunnel'],
      summary: 'List tunnel connections for the account',
      description:
        'Direct account-level fleet access. Project and service credentials must use a Computer Tunnel connector profile.',
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
      method: 'post',
      path: '/',
      tags: ['tunnel'],
      summary: 'Register a new tunnel connection',
      security: [{ bearerAuth: [] }],
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                name: z.string(),
                capabilities: z.array(z.string()).optional(),
              }),
            },
          },
        },
      },
      responses: {
        201: json(ConnectionSchema, 'The created connection, including the one-time setupToken'),
        ...errors(400, 401, 403),
      },
    }),
    async (c: any) => {
      const { accountId } = await getTunnelOwnerContext(c);
      const body = await c.req.json();

      const { name, capabilities } = body;

      if (!name || typeof name !== 'string' || !name.trim() || name.length > 255) {
        return c.json({ error: 'name is required' }, 400);
      }
      if (capabilities !== undefined && !validCapabilities(capabilities)) {
        return c.json({ error: 'capabilities must contain unique supported capabilities' }, 400);
      }

      const setupToken = generateTunnelToken();
      const setupTokenHash = hashSecretKey(setupToken);

      const [connection] = await db
        .insert(tunnelConnections)
        .values({
          accountId,
          name: name.trim(),
          capabilities: capabilities || [],
          status: 'offline',
          setupTokenHash,
        })
        .returning(SAFE_CONNECTION_COLUMNS);

      // Reconcile now for previously-connected rows; a first-time machine is
      // materialized by the WS handshake after last_heartbeat_at is set.
      void reconcileComputerConnectors(accountId);

      return c.json({ ...connection, setupToken }, 201);
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
      summary: 'Update a tunnel connection (name, capabilities)',
      security: [{ bearerAuth: [] }],
      request: {
        params: z.object({ tunnelId: z.string() }),
        body: {
          content: {
            'application/json': {
              schema: z.object({
                name: z.string().optional(),
                capabilities: z.array(z.string()).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: json(ConnectionSchema, 'The updated connection'),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      const { accountId, ownerClause } = await getTunnelOwnerContext(c);
      const tunnelId = c.req.param('tunnelId');
      const body = await c.req.json();

      if (
        body.name !== undefined &&
        (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 255)
      ) {
        return c.json(
          {
            error: 'name must be a non-empty string of at most 255 characters',
          },
          400,
        );
      }
      if (body.capabilities !== undefined && !validCapabilities(body.capabilities)) {
        return c.json({ error: 'capabilities must contain unique supported capabilities' }, 400);
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) updates.name = body.name.trim();
      if (body.capabilities !== undefined) updates.capabilities = body.capabilities;

      const updated = await db.transaction(async (tx) => {
        const [connection] = await tx
          .update(tunnelConnections)
          .set(updates)
          .where(and(eq(tunnelConnections.tunnelId, tunnelId), ownerClause))
          .returning(SAFE_CONNECTION_COLUMNS);
        if (!connection) return null;

        if (body.capabilities !== undefined) {
          const removedCapabilityClause =
            body.capabilities.length === 0
              ? eq(tunnelPermissions.tunnelId, tunnelId)
              : and(
                  eq(tunnelPermissions.tunnelId, tunnelId),
                  notInArray(tunnelPermissions.capability, body.capabilities),
                );
          await tx
            .update(tunnelPermissions)
            .set({ status: 'revoked', updatedAt: new Date() })
            .where(and(removedCapabilityClause, eq(tunnelPermissions.status, 'active')));
        }
        return connection;
      });

      if (!updated) {
        return c.json({ error: 'Tunnel connection not found' }, 404);
      }

      // Machine names are connector profile names. Keep every project copy in
      // sync after a rename or capability update.
      void reconcileComputerConnectors(accountId);

      if (body.capabilities !== undefined) {
        const activePermissions = await db
          .select({
            permissionId: tunnelPermissions.permissionId,
            capability: tunnelPermissions.capability,
            scope: tunnelPermissions.scope,
            expiresAt: tunnelPermissions.expiresAt,
          })
          .from(tunnelPermissions)
          .where(
            and(eq(tunnelPermissions.tunnelId, tunnelId), eq(tunnelPermissions.status, 'active')),
          );
        tunnelRelay.sendNotification(tunnelId, 'tunnel.permissions.sync', {
          permissions: activePermissions.map((permission) => ({
            ...permission,
            expiresAt: permission.expiresAt?.toISOString() ?? undefined,
          })),
        });
      }

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
      summary: 'Delete a tunnel connection while preserving its audit history',
      security: [{ bearerAuth: [] }],
      request: { params: z.object({ tunnelId: z.string() }) },
      responses: {
        200: json(z.object({ success: z.boolean() }), 'Deletion result'),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      const { accountId, ownerClause } = await getTunnelOwnerContext(c);
      const tunnelId = c.req.param('tunnelId');

      const [deleted] = await db
        .delete(tunnelConnections)
        .where(and(eq(tunnelConnections.tunnelId, tunnelId), ownerClause))
        .returning();

      if (!deleted) {
        return c.json({ error: 'Tunnel connection not found' }, 404);
      }

      tunnelRelay.disconnectAgent(tunnelId, 4003, 'tunnel deleted');

      // Tear down this machine's connector profile across the account's projects.
      void reconcileComputerConnectors(accountId);

      return c.json({ success: true });
    },
  );

  return router;
}
