// SCIM Groups routes: GET (list), GET/:id, POST, PATCH (member add/remove,
// rename), DELETE. Registers onto the shared scimRouter via side effect.

import { createRoute, z } from '@hono/zod-openapi';
import { accountGroupMembers, accountGroups, accountInvitations, accountMembers } from '@kortix/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { invalidateIamCacheForGroup, invalidateIamCacheForUsers } from '../iam/cache-invalidation';
import { scimError } from '../middleware/scim-auth';
import { errors, json } from '../openapi';
import { db } from '../shared/db';
import {
  ScimResource,
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
 * ride-along used for project grants. Values matching neither are ignored (RFC
 * 7644 tolerates unknown members). Insert-only — removals are handled by the
 * caller.
 */
async function addGroupMembersOrDeferInvites(
  accountId: string,
  groupId: string,
  memberValues: string[],
): Promise<void> {
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
  for (const inv of invites) {
    const resolvedUserId = await userIdByEmail(inv.email, accountId);
    let resolvedMemberUserId: string | null = null;
    if (resolvedUserId) {
      const [member] = await db
        .select({ userId: accountMembers.userId })
        .from(accountMembers)
        .where(
          and(
            eq(accountMembers.accountId, accountId),
            eq(accountMembers.userId, resolvedUserId),
          ),
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
    const existing = inv.bootstrapGrants ?? [];
    if (existing.some((g) => 'group_id' in g && g.group_id === groupId)) continue;
    await db
      .update(accountInvitations)
      .set({ bootstrapGrants: [...existing, { group_id: groupId }] })
      .where(eq(accountInvitations.inviteId, inv.inviteId));
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
        and(eq(accountGroupMembers.groupId, groupId), eq(accountGroupMembers.userId, resolvedUserId)),
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
      query: z.object({ filter: z.string().optional() }),
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

    const resources = await Promise.all(filteredRows.map((r) => buildGroup(accountId, r)));
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
      if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
        return scimError(c, 409, 'A group with this displayName already exists');
      }
      throw err;
    }

    // Initial members can be supplied in the create body (Okta's group push
    // does this). Same resolution rules as PATCH adds — a plain member-only
    // filter here would silently drop invited/JIT people.
    if (Array.isArray(body.members)) {
      const userIds = (body.members as Array<{ value?: unknown }>)
        .map((m) => (typeof m.value === 'string' ? m.value : null))
        .filter((v): v is string => !!v);
      await addGroupMembersOrDeferInvites(accountId, groupId, userIds);
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

    // Snapshot the pre-PATCH members so we can bust REMOVED users too (the
    // current-member helper below only covers who's left after the ops).
    const beforeMemberIds = (
      await db
        .select({ userId: accountGroupMembers.userId })
        .from(accountGroupMembers)
        .where(eq(accountGroupMembers.groupId, groupId))
    ).map((r) => r.userId);

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
          // Wholesale replace: drop existing rows AND parked grants, then add
          // the new set — real members join now, pending invites re-park. The
          // un-park keeps a person the IdP dropped pre-login from joining the
          // group at first sign-in off a stale grant.
          await db.delete(accountGroupMembers).where(eq(accountGroupMembers.groupId, groupId));
          await unparkGroupFromInvites(accountId, groupId);
          await addGroupMembersOrDeferInvites(accountId, groupId, userIds);
        }
        continue;
      }

      // Member adds: op=add, path=members, value=[{value:userId}, ...]
      if (opName === 'add' && path === 'members' && Array.isArray(op.value)) {
        const userIds = (op.value as Array<{ value?: unknown }>)
          .map((m) => (typeof m.value === 'string' ? m.value : null))
          .filter((u): u is string => !!u);
        await addGroupMembersOrDeferInvites(accountId, groupId, userIds);
        continue;
      }

      // Member removes: path looks like members[value eq "userId"]. The value
      // may be a user_id OR the invitation id the IdP cached at provisioning —
      // removeGroupMemberValue resolves both (and un-parks a pending grant).
      if (opName === 'remove' && path.startsWith('members')) {
        const m = path.match(/value\s+eq\s+"([^"]+)"/i);
        if (m) {
          await removeGroupMemberValue(accountId, groupId, m[1]!);
        } else if (!path.includes('[')) {
          // Bare `remove members` (no filter) — empty the group, both live
          // rows and parked grants.
          await db.delete(accountGroupMembers).where(eq(accountGroupMembers.groupId, groupId));
          await unparkGroupFromInvites(accountId, groupId);
        }
        continue;
      }
    }

    await db
      .update(accountGroups)
      .set({ updatedAt: new Date() })
      .where(eq(accountGroups.groupId, groupId));

    // Membership may have changed → bust both who was a member before and who is
    // now, so role changes via this group apply immediately (not after the TTL).
    invalidateIamCacheForUsers(beforeMemberIds);
    await invalidateIamCacheForGroup(groupId);

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

    // Capture members before the cascade so we can bust their cached roles —
    // deleting the group drops every grant it conferred.
    const memberIds = (
      await db
        .select({ userId: accountGroupMembers.userId })
        .from(accountGroupMembers)
        .where(eq(accountGroupMembers.groupId, groupId))
    ).map((r) => r.userId);

    const rows = await db
      .delete(accountGroups)
      .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.groupId, groupId)))
      .returning({ groupId: accountGroups.groupId, name: accountGroups.name });
    if (rows.length === 0) return c.body(null, 204);
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
