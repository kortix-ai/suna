import { createRoute, z } from '@hono/zod-openapi';
import { eq, and } from 'drizzle-orm';
import { tunnelConnections } from '@kortix/db';
import { db } from '../../shared/db';
import { TunnelErrorCode } from 'agent-tunnel';
import { executeTunnelRpc } from '../core/rpc-core';
import { getTunnelReadContext } from './auth';
import type { AppEnv } from '../../types';
import { makeOpenApiApp, json, errors } from '../../openapi';

export function createRpcRouter() {
  const router = makeOpenApiApp<AppEnv>();

  router.openapi(
    createRoute({
      method: 'post',
      path: '/{tunnelId}',
      tags: ['tunnel'],
      summary: 'Relay an RPC call to the connected local agent',
      security: [{ bearerAuth: [] }],
      request: {
        params: z.object({ tunnelId: z.string() }),
        body: {
          content: {
            'application/json': {
              schema: z.object({
                method: z.string(),
                params: z.record(z.string(), z.any()).optional(),
              }),
            },
          },
        },
      },
      responses: {
        // Opaque agent RPC result — shape depends on the relayed method.
        200: json(z.object({ result: z.any() }), 'The relayed RPC result'),
        // 403 here carries a permission-required envelope (requestId), not a plain error.
        ...errors(400, 401, 403, 404, 429, 500, 502, 504),
      },
    }),
    async (c: any) => {
      const { accountId, ownerClause } = await getTunnelReadContext(c);
      const tunnelId = c.req.param('tunnelId');

      const body = await c.req.json();
      const { method, params = {} } = body;

      // Ownership / existence: scoped to the caller's account (personal or team).
      // The shared core then handles rate-limit / capability / permission /
      // relay / audit — the same path the Executor's `computer` connector uses.
      const [tunnel] = await db
        .select()
        .from(tunnelConnections)
        .where(and(eq(tunnelConnections.tunnelId, tunnelId), ownerClause));

      if (!tunnel) {
        return c.json({ error: 'Tunnel connection not found' }, 404);
      }

      const outcome = await executeTunnelRpc({ tunnelId, accountId, method, params });

      if (outcome.ok) {
        return c.json({ result: outcome.result });
      }
      switch (outcome.kind) {
        case 'permission_required':
          return c.json(
            {
              error: 'Permission required',
              code: TunnelErrorCode.PERMISSION_DENIED,
              requestId: outcome.requestId,
              message: outcome.message,
            },
            403,
          );
        case 'rate_limited':
          return c.json(
            { error: outcome.message, code: TunnelErrorCode.RATE_LIMITED, retryAfterMs: outcome.retryAfterMs },
            429,
          );
        case 'bad_request':
          return c.json({ error: outcome.message }, 400);
        case 'error':
          return c.json({ error: outcome.message, code: outcome.code }, outcome.httpStatus);
      }
    },
  );

  return router;
}
