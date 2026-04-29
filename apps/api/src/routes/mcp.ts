/**
 * Personal MCP server routes.
 *
 * Mounted at /v1/mcp/* with combinedAuth.
 *
 * Routes:
 *   GET    /v1/mcp/personal          — list all for the authed user
 *   POST   /v1/mcp/personal          — create new
 *   GET    /v1/mcp/personal/:id      — get one (must belong to user)
 *   PUT    /v1/mcp/personal/:id      — update
 *   DELETE /v1/mcp/personal/:id      — delete
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { eq, and, sql } from 'drizzle-orm';
import { personalMcpServers } from '@kortix/db';
import { db } from '../shared/db';

export const mcpApp = new Hono<AppEnv>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uid(c: any): string {
  return c.get('userId') as string;
}

// ─── GET /v1/mcp/personal ─────────────────────────────────────────────────────

mcpApp.get('/personal', async (c) => {
  const userId = uid(c);

  const rows = await db
    .select()
    .from(personalMcpServers)
    .where(eq(personalMcpServers.userId, userId))
    .orderBy(personalMcpServers.createdAt);

  return c.json({
    servers: rows.map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      headers: r.headers ?? {},
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  });
});

// ─── POST /v1/mcp/personal ────────────────────────────────────────────────────

mcpApp.post('/personal', async (c) => {
  const userId = uid(c);
  const body = await c.req.json<{ name?: string; url?: string; headers?: Record<string, string> }>();

  if (!body.name?.trim() || !body.url?.trim()) {
    return c.json({ error: 'name and url are required' }, 400);
  }

  const [row] = await db
    .insert(personalMcpServers)
    .values({
      userId,
      name: body.name.trim(),
      url: body.url.trim(),
      headers: body.headers ?? {},
    })
    .returning();

  if (!row) return c.json({ error: 'Insert failed' }, 500);

  return c.json({
    server: {
      id: row.id,
      name: row.name,
      url: row.url,
      headers: row.headers ?? {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  }, 201);
});

// ─── GET /v1/mcp/personal/:id ─────────────────────────────────────────────────

mcpApp.get('/personal/:id', async (c) => {
  const userId = uid(c);
  const id = c.req.param('id');

  const [row] = await db
    .select()
    .from(personalMcpServers)
    .where(and(eq(personalMcpServers.id, id), eq(personalMcpServers.userId, userId)))
    .limit(1);

  if (!row) return c.json({ error: 'Not found' }, 404);

  return c.json({
    server: {
      id: row.id,
      name: row.name,
      url: row.url,
      headers: row.headers ?? {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  });
});

// ─── PUT /v1/mcp/personal/:id ─────────────────────────────────────────────────

mcpApp.put('/personal/:id', async (c) => {
  const userId = uid(c);
  const id = c.req.param('id');
  const body = await c.req.json<{ name?: string; url?: string; headers?: Record<string, string> }>();

  // Verify ownership
  const [existing] = await db
    .select({ id: personalMcpServers.id })
    .from(personalMcpServers)
    .where(and(eq(personalMcpServers.id, id), eq(personalMcpServers.userId, userId)))
    .limit(1);

  if (!existing) return c.json({ error: 'Not found' }, 404);

  const updates: Partial<typeof personalMcpServers.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.url !== undefined) updates.url = body.url.trim();
  if (body.headers !== undefined) updates.headers = body.headers;

  const [row] = await db
    .update(personalMcpServers)
    .set(updates)
    .where(and(eq(personalMcpServers.id, id), eq(personalMcpServers.userId, userId)))
    .returning();

  if (!row) return c.json({ error: 'Update failed' }, 500);

  return c.json({
    server: {
      id: row.id,
      name: row.name,
      url: row.url,
      headers: row.headers ?? {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  });
});

// ─── DELETE /v1/mcp/personal/:id ─────────────────────────────────────────────

mcpApp.delete('/personal/:id', async (c) => {
  const userId = uid(c);
  const id = c.req.param('id');

  const [deleted] = await db
    .delete(personalMcpServers)
    .where(and(eq(personalMcpServers.id, id), eq(personalMcpServers.userId, userId)))
    .returning({ id: personalMcpServers.id });

  if (!deleted) return c.json({ error: 'Not found' }, 404);

  return c.json({ ok: true });
});
