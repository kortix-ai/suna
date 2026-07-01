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
import { Effect } from 'effect';
import { eq, and, desc } from 'drizzle-orm';
import { tunnelConnections } from '@kortix/db';
import { runSharedTimeout, sharedDb as db } from '../../shared/effect';
import { tunnelRelay } from '../core/relay';
import { generateTunnelToken, hashSecretKey } from '../../shared/crypto';
import type { AppEnv } from '../../types';
import { makeOpenApiApp, json, errors } from '../../openapi';
import { getTunnelOwnerContextEffect, getTunnelReadContextEffect } from './auth';
import { reconcileComputerConnectors } from '../../executor/sync';
import { isTunnelConnectionLive } from '../core/cluster-forwarder';
import {
  attemptTunnel,
  attemptTunnelSync,
  parseJsonBody,
  runTunnelEffect,
  sendTunnelJson,
  tunnelFail,
  tunnelJson,
} from './effect-workflows';

/** Permissive connection row shape, as persisted + serialized. */
const ConnectionSchema = z.record(z.string(), z.any());

function serializeConnection(conn: typeof tunnelConnections.$inferSelect) {
  const isLive = isTunnelConnectionLive(conn);
  return {
    ...conn,
    status: isLive ? 'online' : 'offline',
    isLive,
  };
}

const listConnectionsEffect = (c: any) =>
  Effect.gen(function* () {
    const { ownerClause } = yield* getTunnelReadContextEffect(c);

    const connections = yield* attemptTunnel(() =>
      db
        .select()
        .from(tunnelConnections)
        .where(ownerClause)
        .orderBy(desc(tunnelConnections.createdAt)),
    );

    return tunnelJson(connections.map(serializeConnection));
  });

const registerConnectionEffect = (c: any) =>
  Effect.gen(function* () {
    const { accountId } = yield* getTunnelOwnerContextEffect(c);
    const body = yield* parseJsonBody<{
      name?: unknown;
      sandboxId?: unknown;
      capabilities?: unknown;
    }>(c);

    const { name, sandboxId, capabilities } = body;

    if (!name || typeof name !== 'string') {
      return yield* tunnelFail({ error: 'name is required' }, 400);
    }

    const setupToken = yield* attemptTunnelSync(() => generateTunnelToken());
    const setupTokenHash = yield* attemptTunnelSync(() => hashSecretKey(setupToken));

    const [connection] = yield* attemptTunnel(() =>
      db
        .insert(tunnelConnections)
        .values({
          accountId,
          name,
          sandboxId: sandboxId || null,
          capabilities: capabilities || [],
          status: 'offline',
          setupTokenHash,
        } as typeof tunnelConnections.$inferInsert)
        .returning(),
    );

    yield* Effect.sync(() => {
      // Materialize the account's `computer` Executor connector (first machine).
      void reconcileComputerConnectors(accountId);
    });

    return tunnelJson({ ...connection, setupToken }, 201);
  });

const getConnectionEffect = (c: any) =>
  Effect.gen(function* () {
    const { ownerClause } = yield* getTunnelReadContextEffect(c);
    const tunnelId = c.req.param('tunnelId');

    const [connection] = yield* attemptTunnel(() =>
      db
        .select()
        .from(tunnelConnections)
        .where(
          and(
            eq(tunnelConnections.tunnelId, tunnelId),
            ownerClause,
          ),
        ),
    );

    if (!connection) {
      return yield* tunnelFail({ error: 'Tunnel connection not found' }, 404);
    }

    return tunnelJson(serializeConnection(connection));
  });

const updateConnectionEffect = (c: any) =>
  Effect.gen(function* () {
    const { ownerClause } = yield* getTunnelOwnerContextEffect(c);
    const tunnelId = c.req.param('tunnelId');
    const body = yield* parseJsonBody<{
      name?: unknown;
      capabilities?: unknown;
      sandboxId?: unknown;
    }>(c);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.capabilities !== undefined) updates.capabilities = body.capabilities;
    if (body.sandboxId !== undefined) updates.sandboxId = body.sandboxId || null;

    const [updated] = yield* attemptTunnel(() =>
      db
        .update(tunnelConnections)
        .set(updates)
        .where(
          and(
            eq(tunnelConnections.tunnelId, tunnelId),
            ownerClause,
          ),
        )
        .returning(),
    );

    if (!updated) {
      return yield* tunnelFail({ error: 'Tunnel connection not found' }, 404);
    }

    return tunnelJson(updated);
  });

const rotateConnectionTokenEffect = (c: any) =>
  Effect.gen(function* () {
    const { ownerClause } = yield* getTunnelOwnerContextEffect(c);
    const tunnelId = c.req.param('tunnelId');

    const [tunnel] = yield* attemptTunnel(() =>
      db
        .select()
        .from(tunnelConnections)
        .where(
          and(
            eq(tunnelConnections.tunnelId, tunnelId),
            ownerClause,
          ),
        ),
    );

    if (!tunnel) {
      return yield* tunnelFail({ error: 'Tunnel connection not found' }, 404);
    }

    const newToken = yield* attemptTunnelSync(() => generateTunnelToken());
    const newTokenHash = yield* attemptTunnelSync(() => hashSecretKey(newToken));

    yield* attemptTunnel(() =>
      db
        .update(tunnelConnections)
        .set({ setupTokenHash: newTokenHash, updatedAt: new Date() })
        .where(eq(tunnelConnections.tunnelId, tunnelId)),
    );

    yield* Effect.sync(() => {
      tunnelRelay.sendNotification(tunnelId, 'tunnel.token.rotated', {
        reason: 'Token rotated by owner',
      });

      runSharedTimeout(() => {
        tunnelRelay.unregisterAgent(tunnelId);
      }, 500);
    });

    return tunnelJson({ tunnelId, setupToken: newToken });
  });

const deleteConnectionEffect = (c: any) =>
  Effect.gen(function* () {
    const { accountId, ownerClause } = yield* getTunnelOwnerContextEffect(c);
    const tunnelId = c.req.param('tunnelId');

    const [deleted] = yield* attemptTunnel(() =>
      db
        .delete(tunnelConnections)
        .where(
          and(
            eq(tunnelConnections.tunnelId, tunnelId),
            ownerClause,
          ),
        )
        .returning(),
    );

    if (!deleted) {
      return yield* tunnelFail({ error: 'Tunnel connection not found' }, 404);
    }

    yield* Effect.sync(() => {
      // Tear down the account's `computer` connector if that was the last machine.
      void reconcileComputerConnectors(accountId);
    });

    return tunnelJson({ success: true });
  });

export function createConnectionsRouter() {
  const router = makeOpenApiApp<AppEnv>();

  router.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['tunnel'],
      summary: 'List tunnel connections for the account',
      description:
        'Readable by any credential scoped to the owning account, including the sandbox agent (apiKey) so it can resolve its tunnel.',
      security: [{ bearerAuth: [] }],
      responses: {
        200: json(z.array(ConnectionSchema), 'Tunnel connections (each with an isLive flag)'),
        ...errors(401, 403),
      },
    }),
    async (c: any) => {
      return sendTunnelJson(c, await runTunnelEffect(listConnectionsEffect(c)));
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
      return sendTunnelJson(c, await runTunnelEffect(registerConnectionEffect(c)));
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
      return sendTunnelJson(c, await runTunnelEffect(getConnectionEffect(c)));
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
      return sendTunnelJson(c, await runTunnelEffect(updateConnectionEffect(c)));
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
      return sendTunnelJson(c, await runTunnelEffect(rotateConnectionTokenEffect(c)));
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
      return sendTunnelJson(c, await runTunnelEffect(deleteConnectionEffect(c)));
    },
  );

  return router;
}
