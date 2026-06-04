import { createRoute, z } from '@hono/zod-openapi';
import { eq, and, desc } from 'drizzle-orm';
import { tunnelPermissions, tunnelConnections } from '@kortix/db';
import { db } from '../../shared/db';
import { tunnelRelay } from '../core/relay';
import { tunnelRateLimiter } from '../core/rate-limiter';
import { isValidCapability, validateScope as validateScopeInput } from '../core/scope-validator';
import { TunnelErrorCode, type TunnelCapability } from 'agent-tunnel';
import type { AppEnv } from '../../types';
import { makeOpenApiApp, json, errors } from '../../openapi';
import { getTunnelOwnerContext } from './auth';

/** Permissive permission row shape, as persisted + serialized. */
const PermissionSchema = z.record(z.string(), z.any());

export function createPermissionsRouter() {
  const router = makeOpenApiApp<AppEnv>();

  router.openapi(
    createRoute({
      method: 'get',
      path: '/{tunnelId}',
      tags: ['tunnel'],
      summary: 'List permissions granted on a tunnel',
      security: [{ bearerAuth: [] }],
      request: { params: z.object({ tunnelId: z.string() }) },
      responses: {
        200: json(z.array(PermissionSchema), 'Permissions for the tunnel'),
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

      const permissions = await db
        .select()
        .from(tunnelPermissions)
        .where(eq(tunnelPermissions.tunnelId, tunnelId))
        .orderBy(desc(tunnelPermissions.createdAt));

      return c.json(permissions);
    },
  );

  router.openapi(
    createRoute({
      method: 'post',
      path: '/{tunnelId}',
      tags: ['tunnel'],
      summary: 'Grant a permission on a tunnel',
      security: [{ bearerAuth: [] }],
      request: {
        params: z.object({ tunnelId: z.string() }),
        body: {
          content: {
            'application/json': {
              schema: z.object({
                capability: z.string(),
                scope: z.record(z.string(), z.any()).optional(),
                expiresAt: z.string().optional(),
              }),
            },
          },
        },
      },
      responses: {
        201: json(PermissionSchema, 'The granted permission'),
        ...errors(400, 401, 403, 404, 429),
      },
    }),
    async (c: any) => {
      const { accountId, ownerClause } = await getTunnelOwnerContext(c);
      const tunnelId = c.req.param('tunnelId');

      const rateCheck = tunnelRateLimiter.check('permGrant', tunnelId);
      if (!rateCheck.allowed) {
        return c.json({
          error: 'Rate limit exceeded',
          code: TunnelErrorCode.RATE_LIMITED,
          retryAfterMs: rateCheck.retryAfterMs,
        }, 429);
      }

      const body = await c.req.json();
      const { capability, scope, expiresAt } = body;

      if (!capability) {
        return c.json({ error: 'capability is required' }, 400);
      }

      if (!isValidCapability(capability)) {
        return c.json({ error: `Invalid capability: ${capability}` }, 400);
      }

      const scopeToStore = scope || {};
      if (scope && Object.keys(scope).length > 0) {
        const scopeResult = validateScopeInput(capability, scope);
        if (!scopeResult.valid) {
          return c.json({ error: `Invalid scope: ${scopeResult.error}` }, 400);
        }
      }

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

      const [permission] = await db
        .insert(tunnelPermissions)
        .values({
          tunnelId,
          accountId,
          capability: capability as TunnelCapability,
          scope: scopeToStore,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        })
        .returning();

      tunnelRelay.sendNotification(tunnelId, 'tunnel.permission.granted', {
        permissionId: permission.permissionId,
        capability: permission.capability,
        scope: permission.scope,
        expiresAt: permission.expiresAt?.toISOString() ?? undefined,
      });

      return c.json(permission, 201);
    },
  );

  router.openapi(
    createRoute({
      method: 'delete',
      path: '/{tunnelId}/{permissionId}',
      tags: ['tunnel'],
      summary: 'Revoke a permission on a tunnel',
      security: [{ bearerAuth: [] }],
      request: {
        params: z.object({ tunnelId: z.string(), permissionId: z.string() }),
      },
      responses: {
        200: json(
          z.object({ success: z.boolean(), permission: PermissionSchema }),
          'The revoked permission',
        ),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      const { ownerClause } = await getTunnelOwnerContext(c);
      const tunnelId = c.req.param('tunnelId');
      const permissionId = c.req.param('permissionId');

      const [tunnel] = await db
        .select({ tunnelId: tunnelConnections.tunnelId })
        .from(tunnelConnections)
        .where(and(eq(tunnelConnections.tunnelId, tunnelId), ownerClause));

      if (!tunnel) {
        return c.json({ error: 'Tunnel connection not found' }, 404);
      }

      const [revoked] = await db
        .update(tunnelPermissions)
        .set({ status: 'revoked', updatedAt: new Date() })
        .where(
          and(
            eq(tunnelPermissions.permissionId, permissionId),
            eq(tunnelPermissions.tunnelId, tunnelId),
          ),
        )
        .returning();

      if (!revoked) {
        return c.json({ error: 'Permission not found' }, 404);
      }

      tunnelRelay.sendNotification(tunnelId, 'tunnel.permission.revoked', {
        permissionId,
      });

      return c.json({ success: true, permission: revoked });
    },
  );

  return router;
}
