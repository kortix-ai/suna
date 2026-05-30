import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { tunnelPermissions, tunnelConnections } from '@kortix/db';
import { db } from '../../shared/db';
import { tunnelRelay } from '../core/relay';
import { tunnelRateLimiter } from '../core/rate-limiter';
import { isValidCapability, validateScope as validateScopeInput } from '../core/scope-validator';
import { TunnelErrorCode, type TunnelCapability } from 'agent-tunnel';
import { getTunnelOwnerContext } from './auth';

export function createPermissionsRouter(): Hono {
  const router = new Hono();

  router.get('/:tunnelId', async (c: any) => {
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
  });

  router.post('/:tunnelId', async (c: any) => {
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
  });

  router.delete('/:tunnelId/:permissionId', async (c: any) => {
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
  });

  return router;
}
