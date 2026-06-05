// SCIM Users routes: GET (list + filter), GET/:id, POST, PATCH, DELETE.
// Registers onto the shared scimRouter via side effect.

import { createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { accountInvitations, accountMembers } from '@kortix/db';
import { db } from '../shared/db';
import { scimError } from '../middleware/scim-auth';
import { json, errors } from '../openapi';
import {
  scimRouter,
  ScimResource,
  parseFilter,
  listResponse,
  locationFor,
  emailsByUserId,
  userIdByEmail,
  buildUser,
  scimAudit,
  type UserShape,
} from './app';

// ─── Users ────────────────────────────────────────────────────────────────

scimRouter.openapi(
  createRoute({
    method: 'get',
    path: '/accounts/{accountId}/Users',
    tags: ['scim'],
    summary: 'List SCIM Users (filter by userName/id/externalId eq)',
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

  // Load every member for the account; cheap because directories that
  // bother with SCIM tend to have <1000 members in a single account.
  const members = await db
    .select({
      userId: accountMembers.userId,
      scimExternalId: accountMembers.scimExternalId,
      joinedAt: accountMembers.joinedAt,
    })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId));

  const emails = await emailsByUserId(members.map((m) => m.userId));
  const allResources: UserShape[] = members
    .filter((m) => emails.has(m.userId))
    .map((m) => buildUser(accountId, m, emails.get(m.userId)!));

  if (!filter) return c.json(listResponse(allResources));

  // Only `userName eq` / `id eq` / `externalId eq` are interesting in
  // practice. Anything else returns an empty list rather than 400 — the
  // IdP can fall back to listing.
  const filtered: UserShape[] =
    filter.attr === 'userName'
      ? (() => {
          const v = filter.value.toLowerCase();
          return allResources.filter((u) => u.userName.toLowerCase() === v);
        })()
      : filter.attr === 'id'
        ? allResources.filter((u) => u.id === filter.value)
        : filter.attr === 'externalId'
          ? allResources.filter((u) => u.externalId === filter.value)
          : [];

  return c.json(listResponse(filtered));
  },
);

scimRouter.openapi(
  createRoute({
    method: 'get',
    path: '/accounts/{accountId}/Users/{userId}',
    tags: ['scim'],
    summary: 'Get a SCIM User',
    request: { params: z.object({ accountId: z.string(), userId: z.string() }) },
    responses: {
      200: json(ScimResource, 'SCIM User'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const accountId = c.req.param('accountId');
  const userId = c.req.param('userId');

  const [member] = await db
    .select({
      userId: accountMembers.userId,
      scimExternalId: accountMembers.scimExternalId,
      joinedAt: accountMembers.joinedAt,
    })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
    .limit(1);
  if (!member) return scimError(c, 404, 'User not found in this account');

  const emails = await emailsByUserId([userId]);
  const email = emails.get(userId);
  if (!email) return scimError(c, 404, 'User has no email on record');

  return c.json(buildUser(accountId, member, email));
  },
);

scimRouter.openapi(
  createRoute({
    method: 'post',
    path: '/accounts/{accountId}/Users',
    tags: ['scim'],
    summary: 'Create / provision a SCIM User',
    request: {
      params: z.object({ accountId: z.string() }),
      body: { content: { 'application/json': { schema: ScimResource } } },
    },
    responses: {
      200: json(ScimResource, 'SCIM User (already a member)'),
      201: json(ScimResource, 'SCIM User created / invited'),
      ...errors(400, 401, 403),
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

  const userName = typeof body.userName === 'string' ? body.userName.trim() : '';
  if (!userName) return scimError(c, 400, 'userName is required');

  const externalId =
    typeof body.externalId === 'string' && body.externalId.trim()
      ? body.externalId.trim()
      : null;

  // Look up an existing Supabase user by email. If none, send an invite —
  // we don't have permission to create a passwordless auth user without
  // additional infra (magic link), so an invite is the safe v1 default.
  const existingUserId = await userIdByEmail(userName);
  if (!existingUserId) {
    // Create or refresh a pending invitation; the IdP retries on next sync
    // so the eventual sign-up gets reconciled.
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const [invite] = await db
      .insert(accountInvitations)
      .values({
        accountId,
        email: userName.toLowerCase(),
        initialRole: 'member',
        expiresAt,
        invitedBy: null,
      })
      .onConflictDoUpdate({
        target: [accountInvitations.accountId, accountInvitations.email],
        set: { expiresAt, initialRole: 'member', acceptedAt: null },
      })
      .returning();

    await scimAudit(c, {
      accountId,
      action: 'scim.user.invite',
      resourceType: 'account_invitation',
      resourceId: invite.inviteId,
      after: { email: userName, external_id: externalId },
    });

    // SCIM expects a User resource even when the human hasn't joined yet.
    // We return a placeholder with id=invite.inviteId and active=false so
    // the IdP can correlate without thinking the create failed.
    return c.json(
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        id: invite.inviteId,
        userName,
        active: false,
        emails: [{ value: userName, primary: true }],
        externalId,
        meta: {
          resourceType: 'User',
          created: invite.createdAt.toISOString(),
          lastModified: invite.createdAt.toISOString(),
          location: locationFor(accountId, 'Users', invite.inviteId),
        },
      },
      201,
    );
  }

  // User exists in Supabase — make sure they're a member of this account.
  // If already a member, refresh the externalId; otherwise insert. SCIM is
  // expected to be idempotent.
  const [existingMember] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(
      and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, existingUserId)),
    )
    .limit(1);

  if (existingMember) {
    if (externalId) {
      await db
        .update(accountMembers)
        .set({ scimExternalId: externalId })
        .where(
          and(
            eq(accountMembers.accountId, accountId),
            eq(accountMembers.userId, existingUserId),
          ),
        );
    }
  } else {
    await db.insert(accountMembers).values({
      accountId,
      userId: existingUserId,
      accountRole: 'member',
      scimExternalId: externalId,
    });
  }

  const [member] = await db
    .select({
      userId: accountMembers.userId,
      scimExternalId: accountMembers.scimExternalId,
      joinedAt: accountMembers.joinedAt,
    })
    .from(accountMembers)
    .where(
      and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, existingUserId)),
    )
    .limit(1);

  await scimAudit(c, {
    accountId,
    action: existingMember ? 'scim.user.update' : 'scim.user.create',
    resourceType: 'account_member',
    resourceId: existingUserId,
    after: { user_id: existingUserId, external_id: externalId, email: userName },
  });

  return c.json(buildUser(accountId, member!, userName), existingMember ? 200 : 201);
  },
);

/**
 * PATCH is the workhorse for IdP sync. Okta uses it to set active=false
 * when deprovisioning. We support a minimal interpretation:
 *   - { "active": false } → remove the user from this account
 *   - { "active": true }  → no-op if already present, re-add if missing-but-known
 *   - { "Operations": [{ op:"replace", path:"active", value:false }, ...] } → same
 *
 * Anything more exotic returns 400 — clearer than silently ignoring.
 */
scimRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/accounts/{accountId}/Users/{userId}',
    tags: ['scim'],
    summary: 'Patch a SCIM User (deactivate / update externalId)',
    request: {
      params: z.object({ accountId: z.string(), userId: z.string() }),
      body: { content: { 'application/json': { schema: ScimResource } } },
    },
    responses: {
      200: json(ScimResource, 'SCIM User'),
      204: { description: 'No content (deactivated / idempotent)' },
      ...errors(400, 401, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const accountId = c.req.param('accountId');
  const userId = c.req.param('userId');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return scimError(c, 400, 'Body must be JSON');
  }

  // Normalise both shapes (top-level fields OR Operations array) into a
  // map of field → value.
  const changes = new Map<string, unknown>();
  if (Array.isArray(body.Operations)) {
    for (const op of body.Operations as Array<Record<string, unknown>>) {
      const opName = typeof op.op === 'string' ? op.op.toLowerCase() : null;
      if (opName !== 'replace' && opName !== 'add') continue;
      const path = typeof op.path === 'string' ? op.path : 'active';
      changes.set(path, op.value);
    }
  } else {
    for (const k of Object.keys(body)) changes.set(k, body[k]);
  }

  const [member] = await db
    .select({
      userId: accountMembers.userId,
      accountRole: accountMembers.accountRole,
      scimExternalId: accountMembers.scimExternalId,
      joinedAt: accountMembers.joinedAt,
    })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
    .limit(1);

  // Deactivate
  if (changes.get('active') === false) {
    if (!member) return c.body(null, 204); // idempotent
    // Refuse to deactivate the last owner — same invariant the human UI
    // enforces. Without this an IdP misconfiguration could lock everyone
    // out of an account.
    if (member.accountRole === 'owner') {
      const owners = await db
        .select({ userId: accountMembers.userId })
        .from(accountMembers)
        .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.accountRole, 'owner')));
      if (owners.length <= 1) {
        return scimError(c, 409, 'Cannot deactivate the last owner of this account');
      }
    }
    await db
      .delete(accountMembers)
      .where(
        and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)),
      );
    await scimAudit(c, {
      accountId,
      action: 'scim.user.deactivate',
      resourceType: 'account_member',
      resourceId: userId,
      before: { user_id: userId, account_role: member.accountRole },
    });
    return c.body(null, 204);
  }

  // Reactivate or update — only meaningful when the user exists.
  if (!member) return scimError(c, 404, 'User not found in this account');

  if (changes.has('externalId') && typeof changes.get('externalId') === 'string') {
    await db
      .update(accountMembers)
      .set({ scimExternalId: changes.get('externalId') as string })
      .where(
        and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)),
      );
  }

  const emails = await emailsByUserId([userId]);
  const email = emails.get(userId);
  return c.json(buildUser(accountId, member, email ?? ''));
  },
);

scimRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/accounts/{accountId}/Users/{userId}',
    tags: ['scim'],
    summary: 'Delete / deprovision a SCIM User',
    request: { params: z.object({ accountId: z.string(), userId: z.string() }) },
    responses: {
      204: { description: 'No content (deleted / idempotent)' },
      ...errors(401, 403, 409),
    },
  }),
  async (c: any) => {
  const accountId = c.req.param('accountId');
  const userId = c.req.param('userId');

  const [member] = await db
    .select({ accountRole: accountMembers.accountRole })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
    .limit(1);
  if (!member) return c.body(null, 204);

  // Same last-owner guard as PATCH active=false.
  if (member.accountRole === 'owner') {
    const owners = await db
      .select({ userId: accountMembers.userId })
      .from(accountMembers)
      .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.accountRole, 'owner')));
    if (owners.length <= 1) {
      return scimError(c, 409, 'Cannot delete the last owner of this account');
    }
  }

  await db
    .delete(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));

  await scimAudit(c, {
    accountId,
    action: 'scim.user.delete',
    resourceType: 'account_member',
    resourceId: userId,
    before: { user_id: userId, account_role: member.accountRole },
  });
  return c.body(null, 204);
  },
);
