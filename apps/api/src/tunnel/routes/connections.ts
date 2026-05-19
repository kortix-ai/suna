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

import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { tunnelConnections } from '@kortix/db';
import { db } from '../../shared/db';
import { tunnelRelay } from '../core/relay';
import { generateTunnelToken, hashSecretKey } from '../../shared/crypto';
import { getTunnelOwnerContext } from './auth';

export function createConnectionsRouter(): Hono {
  const router = new Hono();

  router.get('/', async (c: any) => {
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
  });

  router.post('/', async (c: any) => {
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
  });

  router.get('/:tunnelId', async (c: any) => {
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
  });

  router.patch('/:tunnelId', async (c: any) => {
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
  });

  router.post('/:tunnelId/rotate-token', async (c: any) => {
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
  });

  router.delete('/:tunnelId', async (c: any) => {
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
  });

  return router;
}
