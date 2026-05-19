/**
 * Tunnel Audit Routes — paginated audit log viewer.
 *
 * GET /audit/:tunnelId — paginated audit logs for a tunnel
 */

import { Hono } from 'hono';
import { eq, and, desc, count } from 'drizzle-orm';
import { tunnelAuditLogs, tunnelConnections } from '@kortix/db';
import { db } from '../../shared/db';
import { getTunnelOwnerContext } from './auth';

export function createAuditRouter(): Hono {
  const router = new Hono();

  router.get('/:tunnelId', async (c: any) => {
    const { ownerClause } = await getTunnelOwnerContext(c);
    const tunnelId = c.req.param('tunnelId');
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
    const offset = (page - 1) * limit;

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

    const [logs, [{ total }]] = await Promise.all([
      db
        .select()
        .from(tunnelAuditLogs)
        .where(eq(tunnelAuditLogs.tunnelId, tunnelId))
        .orderBy(desc(tunnelAuditLogs.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(tunnelAuditLogs)
        .where(eq(tunnelAuditLogs.tunnelId, tunnelId)),
    ]);

    return c.json({
      data: logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  });

  return router;
}
