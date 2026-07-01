/**
 * Tunnel Audit Routes — paginated audit log viewer.
 *
 * GET /audit/:tunnelId — paginated audit logs for a tunnel
 */

import { createRoute, z } from '@hono/zod-openapi';
import { Effect } from 'effect';
import { eq, and, desc, count } from 'drizzle-orm';
import { tunnelAuditLogs, tunnelConnections } from '@kortix/db';
import { sharedDb as db } from '../../shared/effect';
import type { AppEnv } from '../../types';
import { makeOpenApiApp, json, errors } from '../../openapi';
import { getTunnelOwnerContextEffect } from './auth';
import { attemptTunnel, runTunnelEffect, sendTunnelJson, tunnelFail, tunnelJson } from './effect-workflows';

const listAuditLogsEffect = (c: any) =>
  Effect.gen(function* () {
    const { ownerClause } = yield* getTunnelOwnerContextEffect(c);
    const tunnelId = c.req.param('tunnelId');
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
    const offset = (page - 1) * limit;

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

    const [logs, [{ total }]] = yield* Effect.all([
      attemptTunnel(() =>
        db
          .select()
          .from(tunnelAuditLogs)
          .where(eq(tunnelAuditLogs.tunnelId, tunnelId))
          .orderBy(desc(tunnelAuditLogs.createdAt))
          .limit(limit)
          .offset(offset),
      ),
      attemptTunnel(() =>
        db
          .select({ total: count() })
          .from(tunnelAuditLogs)
          .where(eq(tunnelAuditLogs.tunnelId, tunnelId)),
      ),
    ]);

    return tunnelJson({
      data: logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  });

export function createAuditRouter() {
  const router = makeOpenApiApp<AppEnv>();

  router.openapi(
    createRoute({
      method: 'get',
      path: '/{tunnelId}',
      tags: ['tunnel'],
      summary: 'Paginated audit logs for a tunnel',
      security: [{ bearerAuth: [] }],
      request: {
        params: z.object({ tunnelId: z.string() }),
        query: z.object({
          page: z.string().optional(),
          limit: z.string().optional(),
        }),
      },
      responses: {
        200: json(
          z.object({
            data: z.array(z.record(z.string(), z.any())),
            pagination: z.object({
              page: z.number(),
              limit: z.number(),
              total: z.number(),
              totalPages: z.number(),
            }),
          }),
          'Paginated audit log entries',
        ),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      return sendTunnelJson(c, await runTunnelEffect(listAuditLogsEffect(c)));
    },
  );

  return router;
}
