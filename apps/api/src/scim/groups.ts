// SCIM Groups routes: GET (list), GET/:id, POST, PATCH (member add/remove,
// rename), PUT (full-state replace — Okta group-push renames), DELETE.
// Registers onto the shared scimRouter via side effect.

import { createRoute, z } from '@hono/zod-openapi';
import { accountGroupMembers, accountGroups, accountInvitations, accountMembers, accountScimUsers } from '@kortix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { invalidateIamCacheForGroup, invalidateIamCacheForUsers } from '../iam/cache-invalidation';
import { scimError } from '../middleware/scim-auth';
import { errors, json } from '../openapi';
import { db } from '../shared/db';
import { deleteGroup } from '../repositories/iam';
import { directoryUserById, directoryGroupIds, saveDirectoryGroups } from './directory-users';
import { groupChanges, memberValues, InvalidGroupMemberError, type GroupChange } from './group-patch';
import {
  ScimResource,
  ScimListQuery,
  buildGroup,
  isUnsupportedFilter,
  listResponse,
  parseFilter,
  scimAudit,
  scimRouter,
  userIdByEmail,
} from './app';

/**
 * Add SCIM-referenced members to a group. The IdP references each member by the
 * SCIM `id` we handed back at user provisioning — which is the user_id for a real
 * member, but the invitation_id for a user who hasn't logged in yet. A real
 * member joins account_group_members immediately; a pending invite can't (no user
 * row exists) so we park the group on the invite's bootstrap_grants and it
 * materializes on acceptance (accounts/invites.ts applyBootstrapGrants), the same
 * ride-along used for project grants. Unknown references fail the request so
 * an IdP can retry after provisioning the missing user.
 */
async function addGroupMembersOrDeferInvites(
  accountId: string,
  groupId: string,
  memberValues: string[],
): Promise<void> {
  const resolved = await Promise.all(memberValues.map(async value => {
    const user = await directoryUserById(accountId, value);
    if (!user) return value;
    if (user.deletedAt) return null;
    await saveDirectoryGroups(user, [...directoryGroupIds(user), groupId]);
    if (!user.active) return null;
    return user.userId ?? user.invitationId;
  }));
  memberValues = resolved.filter((value): value is string => value !== null);
  if (memberValues.length === 0) return;

  const realMembers = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(
      and(eq(accountMembers.accountId, accountId), inArray(accountMembers.userId, memberValues)),
    );
  const memberSet = new Set(realMembers.map((m) => m.userId));

  const rows = memberValues.filter((v) => memberSet.has(v)).map((v) => ({ groupId, userId: v }));
  if (rows.length > 0) {
    await db.insert(accountGroupMembers).values(rows).onConflictDoNothing();
  }

  // Anything not a real member may be a pending invite (SCIM id = invite_id).
  // The IdP caches that id forever, but the person can BECOME a member through
  // a different door — SSO JIT auto-create — without ever "accepting" the
  // invite. So resolve each invite's EMAIL to a live member first and add them
  // directly; only park on the invite when the person truly isn't in yet.
  const unmatched = memberValues.filter((v) => !memberSet.has(v));
  if (unmatched.length === 0) return;
  const invites = await db
    .select({
      inviteId: accountInvitations.inviteId,
      email: accountInvitations.email,
      acceptedAt: accountInvitations.acceptedAt,
      bootstrapGrants: accountInvitations.bootstrapGrants,
    })
    .from(accountInvitations)
    .where(
      and(
        eq(accountInvitations.accountId, accountId),
        inArray(accountInvitations.inviteId, unmatched),
      ),
    );
  const knownInvites = new Set(invites.map(invite => invite.inviteId));
  if (unmatched.some(value => !knownInvites.has(value))) throw new InvalidGroupMemberError('A referenced user does not exist in this account');
  for (const inv of invites) {
    const resolvedUserId = await userIdByEmail(inv.email, accountId);
    let resolvedMemberUserId: string | null = null;
    if (resolvedUserId) {
      const [member] = await db
        .select({ userId: accountMembers.userId })
        .from(accountMembers)
        .where(
          and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, resolvedUserId)),
        )
        .limit(1);
      resolvedMemberUserId = member?.userId ?? null;
    }

    const action = resolveInviteMemberAction({
      accepted: inv.acceptedAt !== null,
      resolvedMemberUserId,
    });
    if (action === 'add-member' && resolvedMemberUserId) {
      await db
        .insert(accountGroupMembers)
        .values({ groupId, userId: resolvedMemberUserId })
        .onConflictDoNothing();
      continue;
    }
    if (action !== 'park') continue;
    // Atomic append. The previous read-modify-write wrote the WHOLE array back
    // from a stale snapshot, so two concurrent parks of DIFFERENT groups onto
    // the same invite clobbered each other (last write wins). `||` concatenates
    // against the row's CURRENT committed value at write time, so both land; the
    // `@>` guard in the WHERE preserves the old same-group idempotency (a
    // duplicate park is a no-op UPDATE instead of appending twice).
    const grantJson = sql`jsonb_build_array(jsonb_build_object('group_id', ${groupId}::text))`;
    await db
      .update(accountInvitations)
      .set({
        bootstrapGrants: sql`COALESCE(${accountInvitations.bootstrapGrants}, '[]'::jsonb) || ${grantJson}`,
      })
      .where(
        and(
          eq(accountInvitations.inviteId, inv.inviteId),
          sql`NOT (COALESCE(${accountInvitations.bootstrapGrants}, '[]'::jsonb) @> ${grantJson})`,
        ),
      );
  }
}

/**
 * Pure decision for a SCIM member value that matched an invitation. Exported
 * for unit tests.
 *
 *  - the person is ALREADY a member (SSO JIT or accepted invite) → add them
 *    to the group directly; parking would strand the membership because JIT
 *    never fires the invite-acceptance path.
 *  - truly pending (no member row, not accepted) → park on the invite; it
 *    materializes at first sign-in.
 *  - accepted but no member row (member since removed) → skip; re-adding a
 *    removed member is a user-provisioning decision, not a group PATCH's.
 */
export function resolveInviteMemberAction(args: {
  accepted: boolean;
  resolvedMemberUserId: string | null;
}): 'add-member' | 'park' | 'skip' {
  if (args.resolvedMemberUserId) return 'add-member';
  if (!args.accepted) return 'park';
  return 'skip';
}

/**
 * Pure: strip a parked `{group_id}` entry from an invite's bootstrap_grants.
 * Exported for unit tests. Project grants and other groups pass through.
 */
export function stripGroupGrant(
  grants: Array<Record<string, unknown>> | null | undefined,
  groupId: string,
): { changed: boolean; remaining: Array<Record<string, unknown>> } {
  const all = grants ?? [];
  const remaining = all.filter((g) => !('group_id' in g && g.group_id === groupId));
  return { changed: remaining.length !== all.length, remaining };
}

/**
 * Un-park a group from pending invites' bootstrap_grants — the flip side of
 * addGroupMembersOrDeferInvites. Without this, an IdP that removes a
 * not-yet-signed-in person from a group (or replaces the member set) leaves
 * the parked grant behind, and the person joins the group at first sign-in
 * despite the IdP having removed them.
 */
async function unparkGroupFromInvites(
  accountId: string,
  groupId: string,
  onlyInviteId?: string,
): Promise<void> {
  const directoryUsers = await db.select().from(accountScimUsers)
    .where(eq(accountScimUsers.accountId, accountId));
  for (const user of directoryUsers) {
    if (onlyInviteId && user.invitationId !== onlyInviteId) continue;
    const groups = directoryGroupIds(user);
    if (groups.includes(groupId)) await saveDirectoryGroups(user, groups.filter(id => id !== groupId));
  }
  const conds = [
    eq(accountInvitations.accountId, accountId),
    isNull(accountInvitations.acceptedAt),
  ];
  if (onlyInviteId) conds.push(eq(accountInvitations.inviteId, onlyInviteId));
  const invites = await db
    .select({
      inviteId: accountInvitations.inviteId,
      bootstrapGrants: accountInvitations.bootstrapGrants,
    })
    .from(accountInvitations)
    .where(and(...conds));
  for (const inv of invites) {
    const { changed, remaining } = stripGroupGrant(inv.bootstrapGrants, groupId);
    if (!changed) continue;
    await db
      .update(accountInvitations)
      .set({ bootstrapGrants: remaining as typeof inv.bootstrapGrants })
      .where(eq(accountInvitations.inviteId, inv.inviteId));
  }
}

/**
 * Remove one SCIM-referenced member from a group, mirroring the resolution
 * rules of the add path. The IdP may reference the person by user_id OR by
 * the invitation id it cached at provisioning time, so:
 *   1. delete a membership row keyed by the value directly,
 *   2. if the value is an invitation: un-park the group from it AND resolve
 *      its email to a live member (SSO JIT) and delete THAT row too.
 * Without (2) a removal for a JIT-signed-in member silently no-ops — access
 * the IdP revoked would persist.
 */
async function removeGroupMemberValue(
  accountId: string,
  groupId: string,
  value: string,
): Promise<void> {
  const directoryUser = await directoryUserById(accountId, value);
  if (directoryUser) {
    await saveDirectoryGroups(directoryUser, directoryGroupIds(directoryUser).filter(id => id !== groupId));
    value = directoryUser.userId ?? directoryUser.invitationId ?? value;
  }
  await db
    .delete(accountGroupMembers)
    .where(and(eq(accountGroupMembers.groupId, groupId), eq(accountGroupMembers.userId, value)));

  const [invite] = await db
    .select({ inviteId: accountInvitations.inviteId, email: accountInvitations.email })
    .from(accountInvitations)
    .where(and(eq(accountInvitations.accountId, accountId), eq(accountInvitations.inviteId, value)))
    .limit(1);
  if (!invite) return;

  await unparkGroupFromInvites(accountId, groupId, invite.inviteId);

  const resolvedUserId = await userIdByEmail(invite.email, accountId);
  if (resolvedUserId) {
    await db
      .delete(accountGroupMembers)
      .where(
        and(
          eq(accountGroupMembers.groupId, groupId),
          eq(accountGroupMembers.userId, resolvedUserId),
        ),
      );
  }
}

// ─── Groups ───────────────────────────────────────────────────────────────

scimRouter.openapi(
  createRoute({
    method: 'get',
    path: '/accounts/{accountId}/Groups',
    tags: ['scim'],
    summary: 'List SCIM Groups (filter by displayName/id/externalId eq)',
    request: {
      params: z.object({ accountId: z.string() }),
      query: ScimListQuery,
    },
    responses: {
      200: json(ScimResource, 'SCIM ListResponse'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    const rawFilter = c.req.query('filter');
    // Supplied-but-unsupported filter → 400, not a silent full-list (RFC 7644 §3.4.2.2).
    if (isUnsupportedFilter(rawFilter)) {
      return scimError(c, 400, 'Unsupported filter — only `attribute eq "value"` is supported');
    }
    const filter = parseFilter(rawFilter);

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
      if (filter.attr.toLowerCase() === 'displayname') {
        filteredRows = rows.filter((r) => r.name.toLowerCase() === filter.value.toLowerCase());
      } else if (filter.attr.toLowerCase() === 'id') {
        filteredRows = rows.filter((r) => r.groupId === filter.value);
      } else if (filter.attr.toLowerCase() === 'externalid') {
        filteredRows = rows.filter((r) => r.externalId === filter.value);
      } else {
        filteredRows = [];
      }
    }

    const resources = await Promise.all(filteredRows.map((r) => buildGroup(accountId, r)));
    return c.json(listResponse(resources.sort((a, b) => a.id.localeCompare(b.id)), c.req.valid('query')));
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

    let initialMembers: string[] = [];
    try { if (body.members !== undefined) initialMembers = memberValues(body.members); }
    catch (error) { return scimError(c, 400, (error as Error).message); }

    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!displayName) return scimError(c, 400, 'displayName is required');
    if (displayName.length > 128) {
      return scimError(c, 400, 'displayName too long (max 128 chars)');
    }

    const externalId =
      typeof body.externalId === 'string' && body.externalId.trim() ? body.externalId.trim() : null;

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
      if ((err as { cause?: { code?: string }; code?: string }).cause?.code === '23505' || (err as { code?: string }).code === '23505') {
        return scimError(c, 409, 'A group with this displayName already exists');
      }
      throw err;
    }

    try { await addGroupMembersOrDeferInvites(accountId, groupId, initialMembers); }
    catch (error) {
      if (error instanceof InvalidGroupMemberError) return scimError(c, 400, error.message);
      throw error;
    }

    await invalidateIamCacheForGroup(groupId);

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

async function applyGroupChanges(accountId: string, groupId: string, changes: GroupChange[]) {
  for (const change of changes) {
    if (change.path === 'displayName') {
      await db.update(accountGroups).set({ name: change.value }).where(eq(accountGroups.groupId, groupId));
    } else if (change.path === 'externalId') {
      await db.update(accountGroups).set({ externalId: change.value }).where(eq(accountGroups.groupId, groupId));
    } else if (change.op === 'replace' || (change.op === 'remove' && change.value === null)) {
      await db.delete(accountGroupMembers).where(eq(accountGroupMembers.groupId, groupId));
      await unparkGroupFromInvites(accountId, groupId);
      if (change.op === 'replace') await addGroupMembersOrDeferInvites(accountId, groupId, change.value!);
    } else if (change.op === 'add') {
      await addGroupMembersOrDeferInvites(accountId, groupId, change.value!);
    } else {
      for (const value of change.value!) await removeGroupMemberValue(accountId, groupId, value);
    }
  }
}

export function parseGroupPut(body: Record<string, unknown>) {
  const changes = groupChanges(body);
  return {
    displayName: changes.find(c => c.path === 'displayName')?.value ?? null,
    externalId: changes.find(c => c.path === 'externalId')?.value ?? null,
    members: changes.find(c => c.path === 'members')?.value ?? null,
  };
}

async function writeGroup(c: any) {
  const accountId = c.req.param('accountId');
  const groupId = c.req.param('groupId');
  const [group] = await db.select().from(accountGroups).where(and(
    eq(accountGroups.accountId, accountId), eq(accountGroups.groupId, groupId),
  )).limit(1);
  if (!group) return scimError(c, 404, 'Group not found');
  let changes: GroupChange[];
  try { changes = groupChanges(await c.req.json(), c.req.method === 'PATCH'); }
  catch (error) { return scimError(c, 400, (error as Error).message); }
  const before = await db.select({ userId: accountGroupMembers.userId }).from(accountGroupMembers)
    .where(eq(accountGroupMembers.groupId, groupId));
  try {
    await applyGroupChanges(accountId, groupId, changes);
  } catch (error) {
    if (error instanceof InvalidGroupMemberError) return scimError(c, 400, error.message);
    const cause = (error as { cause?: { code?: string }; code?: string });
    if (cause.code === '23505' || cause.cause?.code === '23505') return scimError(c, 409, 'A group with this displayName already exists');
    throw error;
  }
  const [updated] = await db.update(accountGroups).set({ source: 'scim', updatedAt: new Date() })
    .where(eq(accountGroups.groupId, groupId)).returning();
  invalidateIamCacheForUsers(before.map(m => m.userId));
  await invalidateIamCacheForGroup(groupId);
  await scimAudit(c, {
    accountId, action: 'scim.group.update', resourceType: 'account_group', resourceId: groupId,
    before: { name: group.name }, after: { operations: changes.length },
  });
  return c.json(await buildGroup(accountId, updated!));
}

for (const method of ['patch', 'put'] as const) {
  scimRouter.openapi(createRoute({
    method, path: '/accounts/{accountId}/Groups/{groupId}', tags: ['scim'],
    summary: method === 'patch' ? 'Patch a SCIM Group' : 'Replace a SCIM Group',
    request: {
      params: z.object({ accountId: z.string().uuid(), groupId: z.string().uuid() }),
      body: { content: { 'application/json': { schema: ScimResource } } },
    },
    responses: { 200: json(ScimResource, 'SCIM Group'), ...errors(400, 401, 403, 404, 409) },
  }), writeGroup);
}

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

    // Capture members before the cascade so we can bust their cached roles —
    // deleting the group drops every grant it conferred.
    const memberIds = (
      await db
        .select({ userId: accountGroupMembers.userId })
        .from(accountGroupMembers)
        .where(eq(accountGroupMembers.groupId, groupId))
    ).map((r) => r.userId);

    // Name first, for the audit event: the delete below takes the row with it.
    const [existing] = await db
      .select({ name: accountGroups.name })
      .from(accountGroups)
      .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.groupId, groupId)))
      .limit(1);
    if (!existing) return c.body(null, 204);
    await unparkGroupFromInvites(accountId, groupId);
    // `deleteGroup`, not a bare delete: it also drops the group's assignments in
    // the same transaction. `role_assignments.principal_id` is polymorphic, so
    // there is no FK for Postgres to cascade, and the grants would outlive the
    // group they belonged to.
    if (!(await deleteGroup(accountId, groupId))) return c.body(null, 204);
    const rows = [{ groupId, name: existing.name }];
    invalidateIamCacheForUsers(memberIds);

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
