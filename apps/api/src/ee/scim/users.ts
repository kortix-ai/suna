// SPDX-License-Identifier: LicenseRef-Kortix-Enterprise
// Kortix Enterprise License (ee/LICENSE): production use needs a Kortix Enterprise subscription.

import { userChanges, applyProfile } from './user-profile';
// SCIM Users routes: GET (list + filter), GET/:id, POST, PATCH, DELETE.
// registerScimUsersRoutes() registers these onto the shared scimRouter.

import { createRoute, z } from '@hono/zod-openapi';
import { accountInvitations, accountMemberships, accountScimUsers, accountGroupMembers } from '@kortix/db';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { offboardMember } from '../../accounts/core/offboard-member';
import { invalidateIamCacheForUser } from '../../iam/cache-invalidation';
import { accountRoleFor, countAccountOwners } from '../../iam/read-models';
import { assignRole, SYSTEM_ACTOR } from '../../iam/assignments';
import { scimError } from './scim-auth';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { scimMemberRow, scimMemberRows } from '../../iam/membership-read';
import { accountGroupsAmong, scimGroupIdsOfUser } from '../../iam/group-read';
import { buildDirectoryUser, directoryUserById, directoryUserByEmail, saveDirectoryUser, directoryGroupIds, type DirectoryUser } from './directory-users';
import {
  ScimResource,
  ScimListQuery,
  type UserShape,
  buildInviteUser,
  buildUser,
  emailsByUserId,
  isUnsupportedFilter,
  listResponse,
  parseFilter,
  scimAudit,
  scimRouter,
  userIdByEmail,
} from './app';

// ─── Users ────────────────────────────────────────────────────────────────

/**
 * Pending (unaccepted, unexpired) invitations for an account. SCIM presents
 * account members AND pending invites uniformly, so the IdP sees every person
 * it pushed — invited users included — as a resolvable, active account rather
 * than a create that appears to have vanished.
 */
async function pendingInviteRows(
  accountId: string,
  onlyInviteId?: string,
): Promise<Array<{ inviteId: string; email: string; createdAt: Date }>> {
  const conds = [
    eq(accountInvitations.accountId, accountId),
    isNull(accountInvitations.acceptedAt),
    gt(accountInvitations.expiresAt, new Date()),
  ];
  if (onlyInviteId) conds.push(eq(accountInvitations.inviteId, onlyInviteId));
  return db
    .select({
      inviteId: accountInvitations.inviteId,
      email: accountInvitations.email,
      createdAt: accountInvitations.createdAt,
    })
    .from(accountInvitations)
    .where(and(...conds));
}

type MemberRow = {
  userId: string;
  accountRole: string;
  scimExternalId: string | null;
  joinedAt: Date;
};

async function getMember(accountId: string, userId: string): Promise<MemberRow | null> {
  // Identity from `account_members`, ROLE from `role_assignments` — the store
  // the engine reads. A SCIM `active` toggle that went through `assignRole()`
  // leaves the legacy column stale on purpose, so serializing it here would
  // report a role the IdP's own write did not produce.
  const [[member], accountRole] = await Promise.all([
    scimMemberRow(accountId, userId),
    accountRoleFor(accountId, userId),
  ]);
  return member ? { ...member, accountRole: accountRole ?? 'member' } : null;
}

/**
 * SCIM's half of the ONE write path. Deprovisioning is `offboardMember`
 * (accounts/core/offboard-member.ts), shared with removal and leave.
 *
 * Best-effort by construction: the mirror trigger on `account_members` already
 * wrote the same canonical row inside the caller's own statement, so a failure
 * here costs the AUDIT EVENT, never the grant. Failing a provisioning call
 * because an audit insert hiccuped would take an enterprise's IdP sync down for
 * a bookkeeping problem.
 */
async function assignScimMembership(accountId: string, userId: string): Promise<void> {
  try {
    await assignRole(SYSTEM_ACTOR, accountId, {
      principal: { type: 'user', id: userId },
      roleKey: 'member',
      scope: { type: 'account' },
      source: 'scim',
    });
  } catch (err) {
    console.warn('[scim] canonical membership assignment failed', {
      accountId,
      userId,
      err: (err as Error)?.message,
    });
  }
}

/** Last-owner guard shared by every deprovision path. */
async function isLastOwner(accountId: string, member: MemberRow): Promise<boolean> {
  if (member.accountRole !== 'owner') return false;
  return (await countAccountOwners(accountId)) <= 1;
}

async function resolveDirectoryUser(accountId: string, id: string): Promise<DirectoryUser | null> {
  const recorded = await directoryUserById(accountId, id);
  if (recorded) return recorded;
  const member = await getMember(accountId, id);
  if (member) {
    const email = (await emailsByUserId([id])).get(id);
    if (!email) return null;
    return saveDirectoryUser({
      accountId, scimId: id, userId: id, userName: email.toLowerCase(),
      externalId: member.scimExternalId, createdAt: member.joinedAt,
    });
  }
  const [invite] = await pendingInviteRows(accountId, id);
  if (!invite) return null;
  return saveDirectoryUser({
    accountId, scimId: id, invitationId: id,
    userName: invite.email.toLowerCase(), createdAt: invite.createdAt,
  });
}

async function applyDirectoryState(c: any, user: DirectoryUser, active: boolean, deleted = false) {
  const userId = user.userId ?? await userIdByEmail(user.userName, user.accountId);
  const member = userId ? await getMember(user.accountId, userId) : null;
  if (!active && member && await isLastOwner(user.accountId, member)) {
    return scimError(c, 409, 'Cannot deactivate the last owner of this account');
  }
  let groupIds = directoryGroupIds(user);
  if (!active && userId) {
    const currentGroups = await scimGroupIdsOfUser(user.accountId, userId);
    groupIds = [...new Set([...groupIds, ...currentGroups.map(g => g.groupId)])];
  }
  if (deleted) groupIds = [];
  user = await saveDirectoryUser({
    ...user, userId, active, deletedAt: deleted ? new Date() : null,
    profile: { ...user.profile, groups: groupIds.map(value => ({ value })) },
  });
  if (!active) {
    if (userId) {
      // The groups were read into the directory row above, so an active:true
      // restores them; offboarding deletes the live rows. A repeated
      // deactivation finds no membership and has nothing left to end.
      const revocationError = member
        ? (await offboardMember(SYSTEM_ACTOR, user.accountId, userId, 'deprovisioned')).tokenRevocationError
        : null;
      await scimAudit(c, {
        accountId: user.accountId, action: deleted ? 'scim.user.delete' : 'scim.user.deactivate',
        resourceType: 'account_member', resourceId: userId,
        before: { user_id: userId, account_role: member?.accountRole ?? null },
        metadata: revocationError ? { token_revocation_failed: true, token_revocation_error: revocationError } : {},
      });
    }
    await db.delete(accountInvitations).where(and(
      eq(accountInvitations.accountId, user.accountId),
      or(eq(accountInvitations.email, user.userName), eq(accountInvitations.inviteId, user.invitationId ?? user.scimId)),
    ));
  } else if (userId) {
    await db.insert(accountMemberships).values({
      accountId: user.accountId, userId, scimExternalId: user.externalId,
    }).onConflictDoUpdate({
      target: [accountMemberships.accountId, accountMemberships.userId],
      set: { scimExternalId: user.externalId },
    });
    if (!member) await assignScimMembership(user.accountId, userId);
    if (groupIds.length) {
      const groups = await accountGroupsAmong(user.accountId, groupIds);
      if (groups.length) await db.insert(accountGroupMembers).values(groups.map(g => ({ groupId: g.groupId, userId }))).onConflictDoNothing();
    }
    invalidateIamCacheForUser(userId);
  } else {
    if (user.invitationId) await db.update(accountInvitations).set({ email: user.userName })
      .where(and(eq(accountInvitations.accountId, user.accountId), eq(accountInvitations.inviteId, user.invitationId)));
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const [invite] = await db.insert(accountInvitations).values({
      inviteId: user.invitationId ?? user.scimId,
      accountId: user.accountId, email: user.userName, initialRole: 'member', expiresAt, invitedBy: null,
      bootstrapGrants: groupIds.map(group_id => ({ group_id })),
    }).onConflictDoUpdate({
      target: [accountInvitations.accountId, accountInvitations.email],
      set: { expiresAt, initialRole: 'member', acceptedAt: null },
    }).returning();
    user = await saveDirectoryUser({ ...user, invitationId: invite!.inviteId });
  }
  return user;
}

const userParams = z.object({ accountId: z.string().uuid(), userId: z.string().uuid() });

async function writeUser(c: any) {
  const accountId = c.req.param('accountId');
  const userId = c.req.param('userId');
  let changes: Map<string, unknown>;
  try { changes = userChanges(await c.req.json(), c.req.method === 'PATCH'); } catch (error) { return scimError(c, 400, (error as Error).message); }
  const user = await resolveDirectoryUser(accountId, userId);
  if (!user || user.deletedAt) return changes.get('active') === false ? c.body(null, 204) : scimError(c, 404, 'User not found in this account');
  const updated = applyProfile(user, changes);
  if (updated.userName !== user.userName) {
    const collision = await directoryUserByEmail(accountId, updated.userName);
    if (collision && collision.scimId !== user.scimId) return scimError(c, 409, 'A user with this userName already exists');
  }
  const result = await applyDirectoryState(c, updated, changes.has('active') ? changes.get('active') as boolean : user.active);
  return result instanceof Response ? result : c.json(buildDirectoryUser(result));
}

export function registerScimUsersRoutes(): void {
  scimRouter.openapi(createRoute({
    method: 'get', path: '/accounts/{accountId}/Users', ...auth, tags: ['scim'],
    summary: 'List SCIM Users (filter by userName/id/externalId eq)',
    request: { params: z.object({ accountId: z.string().uuid() }), query: ScimListQuery },
    responses: { 200: json(ScimResource, 'SCIM ListResponse'), ...errors(400, 401, 403) },
  }), async (c: any) => {
    const accountId = c.req.param('accountId');
    const rawFilter = c.req.query('filter');
    if (isUnsupportedFilter(rawFilter)) return scimError(c, 400, 'Unsupported filter');
    const filter = parseFilter(rawFilter);
    const recorded = await db.select().from(accountScimUsers).where(eq(accountScimUsers.accountId, accountId));
    const members = await scimMemberRows(accountId);
    const emails = await emailsByUserId(members.map(m => m.userId));
    const recordedEmails = new Set(recorded.map(u => u.userName));
    const recordedIds = new Set(recorded.flatMap(u => [u.scimId, u.userId, u.invitationId]).filter(Boolean));
    const memberEmails = new Set([...emails.values()].map(e => e.toLowerCase()));
    const invites = await pendingInviteRows(accountId);
    let resources: UserShape[] = [
      ...recorded.filter(u => !u.deletedAt).map(buildDirectoryUser),
      ...members.filter(m => emails.has(m.userId) && !recordedIds.has(m.userId) && !recordedEmails.has(emails.get(m.userId)!.toLowerCase()))
        .map(m => buildUser(accountId, m, emails.get(m.userId)!)),
      ...invites.filter(i => !recordedIds.has(i.inviteId) && !recordedEmails.has(i.email.toLowerCase()) && !memberEmails.has(i.email.toLowerCase()))
        .map(i => buildInviteUser(accountId, i)),
    ];
    if (filter) resources = resources.filter(u => {
      if (filter.attr.toLowerCase() === 'username') return u.userName.toLowerCase() === filter.value.toLowerCase();
      if (filter.attr.toLowerCase() === 'id') return u.id === filter.value;
      if (filter.attr.toLowerCase() === 'externalid') return u.externalId === filter.value;
      return false;
    });
    return c.json(listResponse(resources.sort((a, b) => a.id.localeCompare(b.id)), c.req.valid('query')));
  });

  scimRouter.openapi(createRoute({
    method: 'get', path: '/accounts/{accountId}/Users/{userId}', ...auth, tags: ['scim'], summary: 'Get a SCIM User',
    request: { params: userParams }, responses: { 200: json(ScimResource, 'SCIM User'), ...errors(400, 401, 403, 404) },
  }), async (c: any) => {
    const user = await resolveDirectoryUser(c.req.param('accountId'), c.req.param('userId'));
    return user && !user.deletedAt ? c.json(buildDirectoryUser(user)) : scimError(c, 404, 'User not found in this account');
  });

  scimRouter.openapi(createRoute({
    method: 'post', path: '/accounts/{accountId}/Users', ...auth, tags: ['scim'], summary: 'Create / provision a SCIM User',
    request: { params: z.object({ accountId: z.string().uuid() }), body: { content: { 'application/json': { schema: ScimResource } } } },
    responses: { 200: json(ScimResource, 'SCIM User (already provisioned)'), 201: json(ScimResource, 'SCIM User created / invited'), ...errors(400, 401, 403, 409) },
  }), async (c: any) => {
    const accountId = c.req.param('accountId');
    let changes: Map<string, unknown>;
    try { changes = userChanges(await c.req.json()); } catch (error) { return scimError(c, 400, (error as Error).message); }
    if (!changes.has('username')) return scimError(c, 400, 'userName is required');
    const userName = (changes.get('username') as string).trim().toLowerCase();
    const existing = await directoryUserByEmail(accountId, userName);
    const userId = existing?.userId ?? await userIdByEmail(userName, accountId);
    const member = userId ? await getMember(accountId, userId) : null;
    const active = changes.get('active') !== false;
    if (!active && member && await isLastOwner(accountId, member)) return scimError(c, 409, 'Cannot deactivate the last owner of this account');
    let user = existing ?? await saveDirectoryUser({
      accountId, scimId: userId ?? crypto.randomUUID(), userId, userName,
      externalId: member?.scimExternalId ?? null, active,
    });
    user = applyProfile(user, changes);
    const result = await applyDirectoryState(c, user, active);
    if (result instanceof Response) return result;
    await scimAudit(c, {
      accountId, action: existing && !existing.deletedAt ? 'scim.user.update' : 'scim.user.create',
      resourceType: 'account_member', resourceId: result.scimId,
      after: { user_id: result.userId, email: result.userName, external_id: result.externalId, active },
    });
    return c.json(buildDirectoryUser(result), (existing && !existing.deletedAt) || member ? 200 : 201);
  });

  for (const method of ['patch', 'put'] as const) {
    scimRouter.openapi(createRoute({
      method, path: '/accounts/{accountId}/Users/{userId}', ...auth, tags: ['scim'],
      summary: method === 'patch' ? 'Patch a SCIM User' : 'Replace a SCIM User',
      request: { params: userParams, body: { content: { 'application/json': { schema: ScimResource } } } },
      responses: { 200: json(ScimResource, 'SCIM User'), 204: { description: 'Already absent' }, ...errors(400, 401, 403, 404, 409) },
    }), writeUser);
  }

  scimRouter.openapi(createRoute({
    method: 'delete', path: '/accounts/{accountId}/Users/{userId}', ...auth, tags: ['scim'], summary: 'Delete / deprovision a SCIM User',
    request: { params: userParams }, responses: { 204: { description: 'Deleted / idempotent' }, ...errors(400, 401, 403, 409) },
  }), async (c: any) => {
    const user = await resolveDirectoryUser(c.req.param('accountId'), c.req.param('userId'));
    if (!user || user.deletedAt) return c.body(null, 204);
    const result = await applyDirectoryState(c, user, false, true);
    return result instanceof Response ? result : c.body(null, 204);
  });
}
