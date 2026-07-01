import { createRoute, z } from '@hono/zod-openapi';
import { Effect } from 'effect';
import { eq, and } from 'drizzle-orm';
import { tunnelConnections } from '@kortix/db';
import { db } from '../../shared/db';
import { TunnelErrorCode } from 'agent-tunnel';
import { executeTunnelRpc } from '../core/rpc-core';
import { getTunnelReadContextEffect } from './auth';
import type { AppEnv } from '../../types';
import { makeOpenApiApp, json, errors } from '../../openapi';
import {
  attemptTunnel,
  parseJsonBody,
  runTunnelEffect,
  sendTunnelJson,
  tunnelFail,
  tunnelJson,
} from './effect-workflows';

const relayRpcEffect = (c: any) =>
  Effect.gen(function* () {
    const { accountId, ownerClause } = yield* getTunnelReadContextEffect(c);
    const tunnelId = c.req.param('tunnelId');

    const body = yield* parseJsonBody<any>(c);
    const { method, params = {} } = body;

    // Ownership / existence: scoped to the caller's account (personal or team).
    // The shared core then handles rate-limit / capability / permission /
    // relay / audit — the same path the Executor's `computer` connector uses.
    const [tunnel] = yield* attemptTunnel(() =>
      db
        .select()
        .from(tunnelConnections)
        .where(and(eq(tunnelConnections.tunnelId, tunnelId), ownerClause)),
    );

    if (!tunnel) {
      return yield* tunnelFail({ error: 'Tunnel connection not found' }, 404);
    }

    const outcome = yield* attemptTunnel(() =>
      executeTunnelRpc({ tunnelId, accountId, method, params }),
    );

    if (outcome.ok) {
      return tunnelJson({ result: outcome.result });
    }
    switch (outcome.kind) {
      case 'permission_required':
        return yield* tunnelFail(
          {
            error: 'Permission required',
            code: TunnelErrorCode.PERMISSION_DENIED,
            requestId: outcome.requestId,
            message: outcome.message,
          },
          403,
        );
      case 'rate_limited':
        return yield* tunnelFail(
          { error: outcome.message, code: TunnelErrorCode.RATE_LIMITED, retryAfterMs: outcome.retryAfterMs },
          429,
        );
      case 'bad_request':
        return yield* tunnelFail({ error: outcome.message }, 400);
      case 'error':
        return yield* tunnelFail({ error: outcome.message, code: outcome.code }, outcome.httpStatus);
    }
  });

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
      return sendTunnelJson(c, await runTunnelEffect(relayRpcEffect(c)));
    },
  );

  return router;
}
