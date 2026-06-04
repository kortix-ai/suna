/**
 * Server entries CRUD — persists user-configured instances to the database.
 *
 * Scoped per-account: each user only sees/modifies their own entries.
 * In local mode (single user), accountId is a static UUID.
 * In cloud mode, accountId is resolved from the Supabase JWT.
 *
 * Stores URL, label, provider, sandboxId, mappedPorts — everything EXCEPT
 * auth tokens (those stay in the browser's localStorage for security).
 *
 * Mounted at /v1/servers/*
 */

import { createRoute, z } from '@hono/zod-openapi';
import { eq, and } from 'drizzle-orm';
import { serverEntries } from '@kortix/db';
import { db } from '../shared/db';
import { type SandboxProviderName } from '../config';
import { supabaseAuth } from '../middleware/auth';
import { resolveAccountId } from '../shared/resolve-account';
import type { AppEnv } from '../types';
import { makeOpenApiApp, json, errors, auth, ErrorSchema } from '../openapi';

export const serversApp = makeOpenApiApp<AppEnv>();

const MANAGED_SERVER_IDS = new Set(['default', 'cloud-sandbox']);
const PATH_PROXY_URL_REGEX = /^https?:\/\/[^/]+\/v1\/p\/([^/]+)\/(\d+)(\/.*)?$/;

function isManagedOrProxyServer(input: {
  id?: string | null;
  url?: string | null;
  provider?: string | null;
  sandboxId?: string | null;
}): boolean {
  if (input.id && (MANAGED_SERVER_IDS.has(input.id) || input.id.startsWith('sandbox-'))) return true;
  if (input.provider) return true;
  if (input.sandboxId) return true;
  if (input.url && PATH_PROXY_URL_REGEX.test(input.url)) return true;
  return false;
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

/** Real persisted server-entry row, as returned by the DB and serialized to JSON. */
const ServerEntrySchema = z
  .object({
    entryId: z.string(),
    id: z.string(),
    accountId: z.string().nullable(),
    label: z.string(),
    url: z.string(),
    isDefault: z.boolean(),
    provider: z.string().nullable(),
    sandboxId: z.string().nullable(),
    mappedPorts: z.record(z.string(), z.string()).nullable(),
    createdAt: z.union([z.date(), z.string()]),
    updatedAt: z.union([z.date(), z.string()]),
  })
  .openapi('ServerEntry');

const ServerInputSchema = z.object({
  id: z.string(),
  label: z.string(),
  url: z.string(),
  isDefault: z.boolean().optional(),
  provider: z.string().optional(),
  sandboxId: z.string().optional(),
  mappedPorts: z.record(z.string(), z.string()).optional(),
});

const IdParamSchema = z.object({ id: z.string() });

// ─── Auth middleware ────────────────────────────────────────────────────────
// In cloud mode: require Supabase JWT. In local mode: inject static userId.

serversApp.use('/*', supabaseAuth);

// ─── Static routes MUST come before parameterized /:id routes ───────────────

// PUT /v1/servers/sync — bulk upsert from frontend (initial sync)
serversApp.openapi(
  createRoute({
    method: 'put',
    path: '/sync',
    tags: ['servers'],
    summary: 'Bulk upsert server entries from the frontend (initial sync)',
    ...auth,
    request: {
      body: { content: { 'application/json': { schema: z.object({ servers: z.array(ServerInputSchema) }) } } },
    },
    responses: {
      200: json(z.array(ServerEntrySchema), 'Upserted server entries'),
      400: json(ErrorSchema, 'Bad request'),
      ...errors(401),
    },
  }),
  async (c) => {
    const userId = c.get('userId');
    const accountId = await resolveAccountId(userId);

    const body = await c.req.json<{
      servers: Array<{
        id: string;
        label: string;
        url: string;
        isDefault?: boolean;
        provider?: SandboxProviderName;
        sandboxId?: string;
        mappedPorts?: Record<string, string>;
      }>;
    }>();

    if (!Array.isArray(body.servers)) {
      return c.json({ error: 'servers array is required' }, 400);
    }

    const results = [];
    for (const s of body.servers) {
      if (!s.id || !s.label || !s.url) continue;
      if (isManagedOrProxyServer(s)) continue;
      const [row] = await db
        .insert(serverEntries)
        .values({
          id: s.id,
          accountId,
          label: s.label,
          url: s.url,
          isDefault: s.isDefault ?? false,
          provider: s.provider ?? null,
          sandboxId: s.sandboxId ?? null,
          mappedPorts: s.mappedPorts ?? null,
        })
        .onConflictDoUpdate({
          target: [serverEntries.accountId, serverEntries.id],
          set: {
            label: s.label,
            url: s.url,
            isDefault: s.isDefault ?? false,
            provider: s.provider ?? null,
            sandboxId: s.sandboxId ?? null,
            mappedPorts: s.mappedPorts ?? null,
            updatedAt: new Date(),
          },
        })
        .returning();
      results.push(row);
    }

    return c.json(results, 200);
  },
);

// ─── CRUD routes ────────────────────────────────────────────────────────────

// GET /v1/servers — list this user's server entries
serversApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['servers'],
    summary: "List this user's server entries",
    ...auth,
    responses: {
      200: json(z.array(ServerEntrySchema), 'Server entries for the authenticated account'),
      ...errors(401),
    },
  }),
  async (c) => {
    const userId = c.get('userId');
    const accountId = await resolveAccountId(userId);

    const rows = await db
      .select()
      .from(serverEntries)
      .where(eq(serverEntries.accountId, accountId))
      .orderBy(serverEntries.createdAt);
    return c.json(rows.filter((row) => !isManagedOrProxyServer(row)));
  },
);

// GET /v1/servers/:id — get a single server entry (scoped to account)
serversApp.openapi(
  createRoute({
    method: 'get',
    path: '/{id}',
    tags: ['servers'],
    summary: 'Get a single server entry (scoped to account)',
    ...auth,
    request: { params: IdParamSchema },
    responses: {
      200: json(ServerEntrySchema, 'The server entry'),
      404: json(ErrorSchema, 'Not found'),
      ...errors(401),
    },
  }),
  async (c) => {
    const userId = c.get('userId');
    const accountId = await resolveAccountId(userId);
    const id = c.req.param('id');

    const [row] = await db
      .select()
      .from(serverEntries)
      .where(and(eq(serverEntries.accountId, accountId), eq(serverEntries.id, id)));
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json(row, 200);
  },
);

// POST /v1/servers — create/upsert a server entry
serversApp.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['servers'],
    summary: 'Create or upsert a server entry',
    ...auth,
    request: {
      body: { content: { 'application/json': { schema: ServerInputSchema } } },
    },
    responses: {
      201: json(ServerEntrySchema, 'The created or upserted server entry'),
      400: json(ErrorSchema, 'Bad request'),
      ...errors(401),
    },
  }),
  async (c) => {
    const userId = c.get('userId');
    const accountId = await resolveAccountId(userId);

    const body = await c.req.json<{
      id: string;
      label: string;
      url: string;
      isDefault?: boolean;
      provider?: SandboxProviderName;
      sandboxId?: string;
      mappedPorts?: Record<string, string>;
    }>();

    if (!body.id || !body.label || !body.url) {
      return c.json({ error: 'id, label, and url are required' }, 400);
    }

    if (isManagedOrProxyServer(body)) {
      return c.json({ error: 'Managed sandbox proxy entries are derived at runtime and are not persisted' }, 400);
    }

    const [row] = await db
      .insert(serverEntries)
      .values({
        id: body.id,
        accountId,
        label: body.label,
        url: body.url,
        isDefault: body.isDefault ?? false,
        provider: body.provider ?? null,
        sandboxId: body.sandboxId ?? null,
        mappedPorts: body.mappedPorts ?? null,
      })
      .onConflictDoUpdate({
        target: [serverEntries.accountId, serverEntries.id],
        set: {
          label: body.label,
          url: body.url,
          isDefault: body.isDefault ?? false,
          provider: body.provider ?? null,
          sandboxId: body.sandboxId ?? null,
          mappedPorts: body.mappedPorts ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();

    return c.json(row, 201);
  },
);

// PUT /v1/servers/:id — update an existing server entry
serversApp.openapi(
  createRoute({
    method: 'put',
    path: '/{id}',
    tags: ['servers'],
    summary: 'Update an existing server entry',
    ...auth,
    request: {
      params: IdParamSchema,
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                label: z.string(),
                url: z.string(),
                isDefault: z.boolean(),
                provider: z.string().nullable(),
                sandboxId: z.string().nullable(),
                mappedPorts: z.record(z.string(), z.string()).nullable(),
              })
              .partial(),
          },
        },
      },
    },
    responses: {
      200: json(ServerEntrySchema, 'The updated server entry'),
      404: json(ErrorSchema, 'Not found'),
      ...errors(401),
    },
  }),
  async (c) => {
    const userId = c.get('userId');
    const accountId = await resolveAccountId(userId);
    const id = c.req.param('id');

    const body = await c.req.json<{
      label?: string;
      url?: string;
      isDefault?: boolean;
      provider?: SandboxProviderName | null;
      sandboxId?: string | null;
      mappedPorts?: Record<string, string> | null;
    }>();

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.label !== undefined) updates.label = body.label;
    if (body.url !== undefined) updates.url = body.url;
    if (body.isDefault !== undefined) updates.isDefault = body.isDefault;
    if (body.provider !== undefined) updates.provider = body.provider;
    if (body.sandboxId !== undefined) updates.sandboxId = body.sandboxId;
    if (body.mappedPorts !== undefined) updates.mappedPorts = body.mappedPorts;

    const [row] = await db
      .update(serverEntries)
      .set(updates)
      .where(and(eq(serverEntries.accountId, accountId), eq(serverEntries.id, id)))
      .returning();

    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json(row, 200);
  },
);

// DELETE /v1/servers/:id — delete a server entry
serversApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}',
    tags: ['servers'],
    summary: 'Delete a server entry',
    ...auth,
    request: { params: IdParamSchema },
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Deletion result'),
      404: json(ErrorSchema, 'Not found'),
      ...errors(401),
    },
  }),
  async (c) => {
    const userId = c.get('userId');
    const accountId = await resolveAccountId(userId);
    const id = c.req.param('id');

    const [row] = await db
      .delete(serverEntries)
      .where(and(eq(serverEntries.accountId, accountId), eq(serverEntries.id, id)))
      .returning();

    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true }, 200);
  },
);
