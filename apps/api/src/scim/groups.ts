// SCIM Groups routes: GET (list), GET/:id, POST, PATCH (member add/remove,
// rename), DELETE. Registers onto the shared scimRouter via side effect.

import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, inArray } from 'drizzle-orm';
import { accountGroupMembers, accountGroups, accountMembers } from '@kortix/db';
import { db } from '../shared/db';
import { scimError } from '../middleware/scim-auth';
import { json, errors } from '../openapi';
import {
  scimRouter,
  ScimResource,
  parseFilter,
  listResponse,
  buildGroup,
  scimAudit,
} from './app';

// ─── Groups ───────────────────────────────────────────────────────────────

scimRouter.openapi(
  createRoute({
    method: 'get',
    path: '/accounts/{accountId}/Groups',
    tags: ['scim'],
    summary: 'List SCIM Groups (filter by displayName/id/externalId eq)',
    request: {
      params: z.object({ accountId: z.string() }),
      query: z.object({ filter: z.string().optional() }),
    },
    responses: {
      200: json(ScimResource, 'SCIM ListResponse'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const accountId = c.req.param('accountId');
  const filter = parseFilter(c.req.query('filter'));

  const rows = await db
    .select({
      groupId: accountGroups.groupId,
      name: accountGroups.name,
      externalId: accountGroups.externalId,
      createdAt: accountGroups.createdAt,
      updatedAt: accountGroups.updatedAt,
    })
    .from(accountGroups)
    .where(eq(accountGroups.accountId, accountId));

  let filteredRows = rows;
  if (filter) {
    if (filter.attr === 'displayName') {
      filteredRows = rows.filter((r) => r.name === filter.value);
    } else if (filter.attr === 'id') {
      filteredRows = rows.filter((r) => r.groupId === filter.value);
    } else if (filter.attr === 'externalId') {
      filteredRows = rows.filter((r) => r.externalId === filter.value);
    } else {
      filteredRows = [];
    }
  }

  const resources = await Promise.all(
    filteredRows.map((r) => buildGroup(accountId, r)),
  );
  return c.json(listResponse(resources));
  },
);

scimRouter.openapi(
  createRoute({
    method: 'get',
    path: '/accounts/{accountId}/Groups/{groupId}',
    tags: ['scim'],
    summary: 'Get a SCIM Group',
    request: { params: z.object({ accountId: z.string(), groupId: z.string() }) },
    responses: {
      200: json(ScimResource, 'SCIM Group'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');

  const [row] = await db
    .select({
      groupId: accountGroups.groupId,
      name: accountGroups.name,
      externalId: accountGroups.externalId,
      createdAt: accountGroups.createdAt,
      updatedAt: accountGroups.updatedAt,
    })
    .from(accountGroups)
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.groupId, groupId)))
    .limit(1);
  if (!row) return scimError(c, 404, 'Group not found');

  return c.json(await buildGroup(accountId, row));
  },
);

scimRouter.openapi(
  createRoute({
    method: 'post',
    path: '/accounts/{accountId}/Groups',
    tags: ['scim'],
    summary: 'Create a SCIM Group',
    request: {
      params: z.object({ accountId: z.string() }),
      body: { content: { 'application/json': { schema: ScimResource } } },
    },
    responses: {
      201: json(ScimResource, 'SCIM Group created'),
      ...errors(400, 401, 403, 409),
    },
  }),
  async (c: any) => {
  const accountId = c.req.param('accountId');
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return scimError(c, 400, 'Body must be JSON');
  }

  const displayName =
    typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (!displayName) return scimError(c, 400, 'displayName is required');
  if (displayName.length > 128) {
    return scimError(c, 400, 'displayName too long (max 128 chars)');
  }

  const externalId =
    typeof body.externalId === 'string' && body.externalId.trim()
      ? body.externalId.trim()
      : null;

  let groupId: string;
  try {
    const [row] = await db
      .insert(accountGroups)
      .values({
        accountId,
        name: displayName,
        source: 'scim',
        externalId,
        createdBy: null,
      })
      .returning();
    groupId = row.groupId;
  } catch (err: unknown) {
    if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
      return scimError(c, 409, 'A group with this displayName already exists');
    }
    throw err;
  }

  // Initial members can be supplied in the create body.
  if (Array.isArray(body.members)) {
    const userIds = (body.members as Array<{ value?: unknown }>)
      .map((m) => (typeof m.value === 'string' ? m.value : null))
      .filter((v): v is string => !!v);
    if (userIds.length > 0) {
      const valid = await db
        .select({ userId: accountMembers.userId })
        .from(accountMembers)
        .where(
          and(
            eq(accountMembers.accountId, accountId),
            inArray(accountMembers.userId, userIds),
          ),
        );
      const validSet = new Set(valid.map((v) => v.userId));
      const rows = userIds
        .filter((u) => validSet.has(u))
        .map((u) => ({ groupId, userId: u }));
      if (rows.length > 0) {
        await db.insert(accountGroupMembers).values(rows).onConflictDoNothing();
      }
    }
  }

  await scimAudit(c, {
    accountId,
    action: 'scim.group.create',
    resourceType: 'account_group',
    resourceId: groupId,
    after: { name: displayName, external_id: externalId },
  });

  const [row] = await db
    .select({
      groupId: accountGroups.groupId,
      name: accountGroups.name,
      externalId: accountGroups.externalId,
      createdAt: accountGroups.createdAt,
      updatedAt: accountGroups.updatedAt,
    })
    .from(accountGroups)
    .where(eq(accountGroups.groupId, groupId))
    .limit(1);

  return c.json(await buildGroup(accountId, row!), 201);
  },
);

/**
 * Group PATCH handles member adds/removes — the high-traffic operation for
 * IdP-driven group sync. Spec is large; we support what IdPs actually send:
 *   - { Operations: [{ op:"add", path:"members", value:[{value:userId}] }] }
 *   - { Operations: [{ op:"remove", path:'members[value eq "..."]' }] }
 *   - { Operations: [{ op:"replace", path:"displayName", value:"X" }] }
 *   - { Operations: [{ op:"replace", value: { members: [{value:userId}, ...] } }] } (Azure AD style)
 */
scimRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/accounts/{accountId}/Groups/{groupId}',
    tags: ['scim'],
    summary: 'Patch a SCIM Group (member add/remove, rename)',
    request: {
      params: z.object({ accountId: z.string(), groupId: z.string() }),
      body: { content: { 'application/json': { schema: ScimResource } } },
    },
    responses: {
      200: json(ScimResource, 'SCIM Group'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');

  const [group] = await db
    .select({ groupId: accountGroups.groupId, name: accountGroups.name })
    .from(accountGroups)
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.groupId, groupId)))
    .limit(1);
  if (!group) return scimError(c, 404, 'Group not found');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return scimError(c, 400, 'Body must be JSON');
  }

  const operations = Array.isArray(body.Operations)
    ? (body.Operations as Array<Record<string, unknown>>)
    : [];

  for (const op of operations) {
    const opName = typeof op.op === 'string' ? op.op.toLowerCase() : '';
    const path = typeof op.path === 'string' ? op.path : '';

    // displayName / externalId replace
    if (opName === 'replace' && path === 'displayName' && typeof op.value === 'string') {
      const next = op.value.trim();
      if (next) {
        await db
          .update(accountGroups)
          .set({ name: next, updatedAt: new Date() })
          .where(eq(accountGroups.groupId, groupId));
      }
      continue;
    }
    if (opName === 'replace' && path === 'externalId' && typeof op.value === 'string') {
      await db
        .update(accountGroups)
        .set({ externalId: op.value, updatedAt: new Date() })
        .where(eq(accountGroups.groupId, groupId));
      continue;
    }

    // Azure AD: replace with no path, value is an object containing members
    if (opName === 'replace' && !path && op.value && typeof op.value === 'object') {
      const v = op.value as Record<string, unknown>;
      if (Array.isArray(v.members)) {
        const userIds = (v.members as Array<{ value?: unknown }>)
          .map((m) => (typeof m.value === 'string' ? m.value : null))
          .filter((u): u is string => !!u);
        // Wholesale replace: drop existing, insert new (validated members only).
        await db
          .delete(accountGroupMembers)
          .where(eq(accountGroupMembers.groupId, groupId));
        if (userIds.length > 0) {
          const valid = await db
            .select({ userId: accountMembers.userId })
            .from(accountMembers)
            .where(
              and(
                eq(accountMembers.accountId, accountId),
                inArray(accountMembers.userId, userIds),
              ),
            );
          const validSet = new Set(valid.map((vv) => vv.userId));
          const rows = userIds
            .filter((u) => validSet.has(u))
            .map((u) => ({ groupId, userId: u }));
          if (rows.length > 0) {
            await db.insert(accountGroupMembers).values(rows).onConflictDoNothing();
          }
        }
      }
      continue;
    }

    // Member adds: op=add, path=members, value=[{value:userId}, ...]
    if (opName === 'add' && path === 'members' && Array.isArray(op.value)) {
      const userIds = (op.value as Array<{ value?: unknown }>)
        .map((m) => (typeof m.value === 'string' ? m.value : null))
        .filter((u): u is string => !!u);
      if (userIds.length === 0) continue;
      const valid = await db
        .select({ userId: accountMembers.userId })
        .from(accountMembers)
        .where(
          and(
            eq(accountMembers.accountId, accountId),
            inArray(accountMembers.userId, userIds),
          ),
        );
      const validSet = new Set(valid.map((v) => v.userId));
      const rows = userIds
        .filter((u) => validSet.has(u))
        .map((u) => ({ groupId, userId: u }));
      if (rows.length > 0) {
        await db.insert(accountGroupMembers).values(rows).onConflictDoNothing();
      }
      continue;
    }

    // Member removes: path looks like members[value eq "userId"]
    if (opName === 'remove' && path.startsWith('members')) {
      const m = path.match(/value\s+eq\s+"([^"]+)"/i);
      if (m) {
        await db
          .delete(accountGroupMembers)
          .where(
            and(
              eq(accountGroupMembers.groupId, groupId),
              eq(accountGroupMembers.userId, m[1]!),
            ),
          );
      }
      continue;
    }
  }

  await db
    .update(accountGroups)
    .set({ updatedAt: new Date() })
    .where(eq(accountGroups.groupId, groupId));

  await scimAudit(c, {
    accountId,
    action: 'scim.group.update',
    resourceType: 'account_group',
    resourceId: groupId,
    before: { name: group.name },
    after: { operations: operations.length },
  });

  const [row] = await db
    .select({
      groupId: accountGroups.groupId,
      name: accountGroups.name,
      externalId: accountGroups.externalId,
      createdAt: accountGroups.createdAt,
      updatedAt: accountGroups.updatedAt,
    })
    .from(accountGroups)
    .where(eq(accountGroups.groupId, groupId))
    .limit(1);
  return c.json(await buildGroup(accountId, row!));
  },
);

scimRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/accounts/{accountId}/Groups/{groupId}',
    tags: ['scim'],
    summary: 'Delete a SCIM Group',
    request: { params: z.object({ accountId: z.string(), groupId: z.string() }) },
    responses: {
      204: { description: 'No content (deleted / idempotent)' },
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');

  const rows = await db
    .delete(accountGroups)
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.groupId, groupId)))
    .returning({ groupId: accountGroups.groupId, name: accountGroups.name });
  if (rows.length === 0) return c.body(null, 204);

  await scimAudit(c, {
    accountId,
    action: 'scim.group.delete',
    resourceType: 'account_group',
    resourceId: groupId,
    before: { name: rows[0]!.name },
  });
  return c.body(null, 204);
  },
);
