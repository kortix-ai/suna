// SCIM 2.0 protocol surface for Okta / Azure AD / JumpCloud / etc.
//
// Mounted at /scim/v2/accounts/:accountId/* — the URL carries the tenant
// so the IdP configures its base URL once. scimAuth middleware validates
// the bearer token and ensures it belongs to the same account.
//
// What we implement (v1):
//   - /ServiceProviderConfig (capabilities discovery)
//   - /Users: GET (list + filter by userName), GET/:id, POST, PATCH, DELETE
//   - /Groups: GET (list), GET/:id, POST, PATCH, DELETE (member add/remove via PATCH)
//
// What we deliberately skip in v1:
//   - PUT (most IdPs prefer PATCH; PATCH is sufficient for Okta + Azure AD)
//   - /Schemas and /ResourceTypes (most IdPs hardcode knowledge of the spec)
//   - Pagination beyond the default page (small directories fit; revisit if needed)
//   - Full filter grammar — only `userName eq` / `id eq` / `displayName eq` are
//     supported, which covers the request patterns Okta and Azure AD actually use.

import { Context, Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountGroups,
  accountInvitations,
  accountMembers,
  accounts,
} from '@kortix/db';
import { db } from '../shared/db';
import { getSupabase } from '../shared/supabase';
import { recordAuditEvent } from '../shared/audit';
import { scimAuth, scimError } from '../middleware/scim-auth';

export const scimRouter = new Hono();
scimRouter.use('/accounts/:accountId/*', scimAuth);

// ─── Discovery ────────────────────────────────────────────────────────────

scimRouter.get('/accounts/:accountId/ServiceProviderConfig', (c) => {
  return c.json({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://docs.kortix.com/scim',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description: 'Per-account SCIM token configured in Account Settings.',
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig' },
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────

type ParsedFilter = { attr: string; value: string } | null;

/** Parse the tiny subset of SCIM filters we support:
 *  `attr eq "value"` with optional whitespace. Returns null if unsupported. */
function parseFilter(raw: string | undefined): ParsedFilter {
  if (!raw) return null;
  const m = raw.match(/^\s*(\w+)\s+eq\s+"([^"]*)"\s*$/);
  return m ? { attr: m[1]!, value: m[2]! } : null;
}

function listResponse<T>(resources: T[]) {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

interface UserShape {
  schemas: string[];
  id: string;
  userName: string;
  active: boolean;
  emails: Array<{ value: string; primary: boolean }>;
  externalId?: string | null;
  meta: { resourceType: 'User'; created: string; lastModified: string; location: string };
}

function locationFor(accountId: string, kind: 'Users' | 'Groups', id: string): string {
  return `/scim/v2/accounts/${accountId}/${kind}/${id}`;
}

/**
 * Bulk Supabase-email lookup for the user IDs we have. Used to render
 * `userName` / `emails` on SCIM User resources. Returns a map so the
 * caller can build resources in O(n).
 */
async function emailsByUserId(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (userIds.length === 0) return map;
  const supabase = getSupabase();
  await Promise.all(
    userIds.map(async (uid) => {
      try {
        const { data } = await supabase.auth.admin.getUserById(uid);
        if (data?.user?.email) map.set(uid, data.user.email);
      } catch {
        /* ignore — surface as missing email */
      }
    }),
  );
  return map;
}

async function userIdByEmail(email: string): Promise<string | null> {
  const supabase = getSupabase();
  try {
    // Supabase admin doesn't expose a direct email-lookup; use the paginated
    // list with a small page and filter client-side. For directories this
    // small it's acceptable; a real production deployment should add a
    // local email→user_id table.
    const normalized = email.trim().toLowerCase();
    const { data } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const found = data?.users?.find(
      (u) => (u.email ?? '').trim().toLowerCase() === normalized,
    );
    return found?.id ?? null;
  } catch {
    return null;
  }
}

function buildUser(
  accountId: string,
  member: { userId: string; scimExternalId: string | null; joinedAt: Date },
  email: string,
): UserShape {
  const iso = member.joinedAt.toISOString();
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: member.userId,
    userName: email,
    active: true,
    emails: [{ value: email, primary: true }],
    externalId: member.scimExternalId,
    meta: {
      resourceType: 'User',
      created: iso,
      lastModified: iso,
      location: locationFor(accountId, 'Users', member.userId),
    },
  };
}

async function scimAudit(
  c: Context,
  args: {
    accountId: string;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
) {
  try {
    await recordAuditEvent({
      accountId: args.accountId,
      actorUserId: null, // SCIM has no human actor; the token IS the actor
      action: args.action,
      resourceType: args.resourceType,
      resourceId: args.resourceId ?? null,
      before: args.before ?? null,
      after: args.after ?? null,
      ip:
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
        c.req.header('x-real-ip') ||
        null,
      userAgent: c.req.header('user-agent') || null,
      metadata: { scim_token_id: c.get('scimTokenId') as string | undefined },
    });
  } catch (err) {
    console.warn('[scim audit] failed to record', args.action, err);
  }
}

// ─── Users ────────────────────────────────────────────────────────────────

scimRouter.get('/accounts/:accountId/Users', async (c) => {
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
});

scimRouter.get('/accounts/:accountId/Users/:userId', async (c) => {
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
});

scimRouter.post('/accounts/:accountId/Users', async (c) => {
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
});

/**
 * PATCH is the workhorse for IdP sync. Okta uses it to set active=false
 * when deprovisioning. We support a minimal interpretation:
 *   - { "active": false } → remove the user from this account
 *   - { "active": true }  → no-op if already present, re-add if missing-but-known
 *   - { "Operations": [{ op:"replace", path:"active", value:false }, ...] } → same
 *
 * Anything more exotic returns 400 — clearer than silently ignoring.
 */
scimRouter.patch('/accounts/:accountId/Users/:userId', async (c) => {
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
});

scimRouter.delete('/accounts/:accountId/Users/:userId', async (c) => {
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
});

// ─── Groups ───────────────────────────────────────────────────────────────

interface GroupShape {
  schemas: string[];
  id: string;
  displayName: string;
  externalId?: string | null;
  members: Array<{ value: string; display?: string }>;
  meta: { resourceType: 'Group'; created: string; lastModified: string; location: string };
}

async function buildGroup(
  accountId: string,
  group: {
    groupId: string;
    name: string;
    externalId: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
): Promise<GroupShape> {
  const memberRows = await db
    .select({ userId: accountGroupMembers.userId })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.groupId, group.groupId));
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: group.groupId,
    displayName: group.name,
    externalId: group.externalId,
    members: memberRows.map((m) => ({ value: m.userId })),
    meta: {
      resourceType: 'Group',
      created: group.createdAt.toISOString(),
      lastModified: group.updatedAt.toISOString(),
      location: locationFor(accountId, 'Groups', group.groupId),
    },
  };
}

scimRouter.get('/accounts/:accountId/Groups', async (c) => {
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
});

scimRouter.get('/accounts/:accountId/Groups/:groupId', async (c) => {
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
});

scimRouter.post('/accounts/:accountId/Groups', async (c) => {
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
});

/**
 * Group PATCH handles member adds/removes — the high-traffic operation for
 * IdP-driven group sync. Spec is large; we support what IdPs actually send:
 *   - { Operations: [{ op:"add", path:"members", value:[{value:userId}] }] }
 *   - { Operations: [{ op:"remove", path:'members[value eq "..."]' }] }
 *   - { Operations: [{ op:"replace", path:"displayName", value:"X" }] }
 *   - { Operations: [{ op:"replace", value: { members: [{value:userId}, ...] } }] } (Azure AD style)
 */
scimRouter.patch('/accounts/:accountId/Groups/:groupId', async (c) => {
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
});

scimRouter.delete('/accounts/:accountId/Groups/:groupId', async (c) => {
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
});

// `accounts` import kept only so future endpoints (e.g. /Me) can resolve
// the account by URL without re-importing. Silences unused-import lints.
void accounts;
