/**
 * Tunnel Connections Routes — CRUD for registered tunnel connections.
 *
 * GET    /connections                      — list connections for account
 * POST   /connections                      — register a new tunnel connection
 * GET    /connections/:tunnelId            — get a single connection
 * PATCH  /connections/:tunnelId            — update connection (name, capabilities)
 * DELETE /connections/:tunnelId            — delete connection (cascades permissions, audit)
 * POST   /connections/:tunnelId/rotate-token — rotate the setup token
 */

import { createRoute, z } from '@hono/zod-openapi';
import { eq, and, desc } from 'drizzle-orm';
import { tunnelConnections } from '@kortix/db';
import { db } from '../../shared/db';
import { tunnelRelay } from '../core/relay';
import { generateTunnelToken, hashSecretKey } from '../../shared/crypto';
import type { AppEnv } from '../../types';
import { makeOpenApiApp, json, errors } from '../../openapi';
import { getTunnelOwnerContext } from './auth';

/** Permissive connection row shape, as persisted + serialized. */
const ConnectionSchema = z.record(z.string(), z.any());

export function createConnectionsRouter() {
  const router = makeOpenApiApp<AppEnv>();

  router.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['tunnel'],
      summary: 'List tunnel connections for the account',
      security: [{ bearerAuth: [] }],
      responses: {
        200: json(z.array(ConnectionSchema), 'Tunnel connections (each with an isLive flag)'),
        ...errors(401, 403),
      },
    }),
    async (c: any) => {
      const { userId, accountId, ownerClause } = await getTunnelOwnerContext(c);

      console.log(`[TUNNEL][GET /connections] userId=${userId} resolvedAccountId=${accountId} same=${userId === accountId}`);

      const connections = await db
        .select()
        .from(tunnelConnections)
        .where(ownerClause)
        .orderBy(desc(tunnelConnections.createdAt));

      console.log(`[TUNNEL][GET /connections] found ${connections.length} connections`, connections.map(c => ({ tunnelId: c.tunnelId, accountId: c.accountId })));

      const enriched = connections.map((conn) => ({
        ...conn,
        isLive: tunnelRelay.isConnected(conn.tunnelId),
      }));

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
                sandboxId: z.string().optional(),
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

      const { name, sandboxId, capabilities } = body;

      if (!name || typeof name !== 'string') {
        return c.json({ error: 'name is required' }, 400);
      }

      const setupToken = generateTunnelToken();
      const setupTokenHash = hashSecretKey(setupToken);

      const [connection] = await db
        .insert(tunnelConnections)
        .values({
          accountId,
          name,
          sandboxId: sandboxId || null,
          capabilities: capabilities || [],
          status: 'offline',
          setupTokenHash,
        })
        .returning();

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
      const { userId, accountId, ownerClause } = await getTunnelOwnerContext(c);
      const tunnelId = c.req.param('tunnelId');

      console.log(`[TUNNEL][GET /:tunnelId] userId=${userId} accountId=${accountId} tunnelId=${tunnelId}`);

      const [connection] = await db
        .select()
        .from(tunnelConnections)
        .where(
          and(
            eq(tunnelConnections.tunnelId, tunnelId),
            ownerClause,
          ),
        );

      console.log(`[TUNNEL][GET /:tunnelId] found=${!!connection}`);

      if (!connection) {
        return c.json({ error: 'Tunnel connection not found' }, 404);
      }

      return c.json({
        ...connection,
        isLive: tunnelRelay.isConnected(connection.tunnelId),
      });
    },
  );

  router.openapi(
    createRoute({
      method: 'patch',
      path: '/{tunnelId}',
      tags: ['tunnel'],
      summary: 'Update a tunnel connection (name, capabilities, sandboxId)',
      security: [{ bearerAuth: [] }],
      request: {
        params: z.object({ tunnelId: z.string() }),
        body: {
          content: {
            'application/json': {
              schema: z.object({
                name: z.string().optional(),
                capabilities: z.array(z.string()).optional(),
                sandboxId: z.string().nullable().optional(),
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
      const { ownerClause } = await getTunnelOwnerContext(c);
      const tunnelId = c.req.param('tunnelId');
      const body = await c.req.json();

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.capabilities !== undefined) updates.capabilities = body.capabilities;
      if (body.sandboxId !== undefined) updates.sandboxId = body.sandboxId || null;

      const [updated] = await db
        .update(tunnelConnections)
        .set(updates)
        .where(
          and(
            eq(tunnelConnections.tunnelId, tunnelId),
            ownerClause,
          ),
        )
        .returning();

      if (!updated) {
        return c.json({ error: 'Tunnel connection not found' }, 404);
      }

      return c.json(updated);
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
        .where(
          and(
            eq(tunnelConnections.tunnelId, tunnelId),
            ownerClause,
          ),
        );

      if (!tunnel) {
        return c.json({ error: 'Tunnel connection not found' }, 404);
      }

      const newToken = generateTunnelToken();
      const newTokenHash = hashSecretKey(newToken);

      await db
        .update(tunnelConnections)
        .set({ setupTokenHash: newTokenHash, updatedAt: new Date() })
        .where(eq(tunnelConnections.tunnelId, tunnelId));

      tunnelRelay.sendNotification(tunnelId, 'tunnel.token.rotated', {
        reason: 'Token rotated by owner',
      });

      setTimeout(() => {
        tunnelRelay.unregisterAgent(tunnelId);
      }, 500);

      return c.json({ tunnelId, setupToken: newToken });
    },
  );

  router.openapi(
    createRoute({
      method: 'delete',
      path: '/{tunnelId}',
      tags: ['tunnel'],
      summary: 'Delete a tunnel connection (cascades permissions + audit)',
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

      const [deleted] = await db
        .delete(tunnelConnections)
        .where(
          and(
            eq(tunnelConnections.tunnelId, tunnelId),
            ownerClause,
          ),
        )
        .returning();

      if (!deleted) {
        return c.json({ error: 'Tunnel connection not found' }, 404);
      }

      return c.json({ success: true });
    },
  );

  return router;
}
