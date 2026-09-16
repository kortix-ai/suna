// SCIM Users routes: GET (list + filter), GET/:id, POST, PATCH, DELETE.
// Registers onto the shared scimRouter via side effect.

import { createRoute, z } from '@hono/zod-openapi';
import { accountInvitations, accountMembers, accountMemberships, accountScimUsers, accountGroups, accountGroupMembers, roleAssignments } from '@kortix/db';
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { invalidateIamCacheForUser } from '../iam/cache-invalidation';
import { accountRoleFor, countAccountOwners } from '../iam/read-models';
import {
  assignRole,
  auditAssignmentRevoked,
  listAssignments,
  SYSTEM_ACTOR,
} from '../iam/assignments';
import { scimError } from '../middleware/scim-auth';
import { errors, json } from '../openapi';
import { revokeAllAccountTokensForUser } from '../repositories/account-tokens';
import { onMemberRemoved } from '../billing/services/seat-management';
import { db } from '../shared/db';
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
    db
      .select({
        userId: accountMembers.userId,
        scimExternalId: accountMembers.scimExternalId,
        joinedAt: accountMembers.joinedAt,
      })
      .from(accountMembers)
      .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
      .limit(1),
    accountRoleFor(accountId, userId),
  ]);
  return member ? { ...member, accountRole: accountRole ?? 'member' } : null;
}

/**
 * SCIM's half of the ONE write path.
 *
 * Both helpers are best-effort by construction: the mirror trigger on
 * `account_members` already wrote (or removed) the same canonical row inside the
 * caller's own statement, so a failure here costs the AUDIT EVENT, never the
 * grant. Failing a provisioning call because an audit insert hiccuped would take
 * an enterprise's IdP sync down for a bookkeeping problem.
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

/**
 * Remove every canonical assignment this principal holds in the account.
 *
 * Deliberately NOT `revokeAssignment` per row: that would run the last-owner
 * guard, and SCIM's callers run their own `isLastOwner` check first (scim/
 * users.ts) — routing through the guard here would turn a legitimate,
 * already-guarded offboarding into a 409 for the second-to-last owner. The audit
 * event is emitted per row so the trail is identical.
 */
async function revokeScimMembership(accountId: string, userId: string): Promise<void> {
  try {
    const rows = await listAssignments({
      accountId,
      principal: { type: 'user', id: userId },
      liveOnly: false,
    });
    if (rows.length === 0) return;
    await db.delete(roleAssignments).where(
      and(
        eq(roleAssignments.accountId, accountId),
        eq(roleAssignments.principalType, 'user'),
        eq(roleAssignments.principalId, userId),
      ),
    );
    for (const row of rows) await auditAssignmentRevoked(SYSTEM_ACTOR, accountId, row);
  } catch (err) {
    console.warn('[scim] canonical membership revoke failed', {
      accountId,
      userId,
      err: (err as Error)?.message,
    });
  }
}

/**
 * Deprovision a live member: remove the membership, bust the IAM cache, and
 * revoke PATs + live sandbox tokens. Callers must run the last-owner guard
 * BEFORE calling. Returns the token-revocation error message (if any) for the
 * audit event; the membership removal itself always proceeds.
 */
async function deprovisionMember(accountId: string, userId: string): Promise<string | null> {
  // Revoke the canonical assignments FIRST, while the membership row still
  // exists to describe them: `revokeAssignment` is the only revoke path that
  // audits, and the audit event has to name what was taken away.
  await revokeScimMembership(accountId, userId);
  // …then the IDENTITY row. Two stores since the cutover: the GRANTS live in
  // kortix.role_assignments, the identity in kortix.account_memberships.
  await db
    .delete(accountMemberships)
    .where(and(eq(accountMemberships.accountId, accountId), eq(accountMemberships.userId, userId)));
  invalidateIamCacheForUser(userId);

  // RELEASE THE PAID SEAT.
  //
  // Removing the member row is not the whole offboarding: on a per-seat account
  // the Stripe subscription quantity is what gets invoiced, and nothing else
  // lowers it. The UI removal path has always called this (accounts/core/
  // members.ts:549 and :704); SCIM never did, so an enterprise offboarding
  // through its IdP — the automated channel we tell enterprises to use — kept
  // paying $40/month for every departed employee, indefinitely. There is no
  // periodic seat reconciler to catch it up.
  //
  // It also revokes the member's YOLO token, which SCIM likewise did not.
  //
  // Awaited, not fire-and-forget: `onMemberRemoved` catches its own errors and
  // returns void, so it cannot fail the SCIM response, and awaiting makes the
  // seat release deterministic rather than racing the reply.
  await onMemberRemoved(accountId, userId);

  return revokeAllAccountTokensForUser(userId, accountId).then(
    () => null,
    (err) => {
      console.error(
        '[scim] token revocation FAILED on deprovision — user may retain live tokens',
        { userId, accountId },
        err,
      );
      return err instanceof Error ? err.message : String(err);
    },
  );
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
    const currentGroups = await db.select({ groupId: accountGroups.groupId }).from(accountGroups)
      .innerJoin(accountGroupMembers, eq(accountGroupMembers.groupId, accountGroups.groupId))
      .where(and(eq(accountGroups.accountId, user.accountId), eq(accountGroups.source, 'scim'), eq(accountGroupMembers.userId, userId)));
    groupIds = [...new Set([...groupIds, ...currentGroups.map(g => g.groupId)])];
  }
  if (deleted) groupIds = [];
  user = await saveDirectoryUser({
    ...user, userId, active, deletedAt: deleted ? new Date() : null,
    profile: { ...user.profile, groups: groupIds.map(value => ({ value })) },
  });
  if (!active) {
    if (userId) {
      const revocationError = await deprovisionMember(user.accountId, userId);
      const groups = await db.select({ id: accountGroups.groupId }).from(accountGroups)
        .where(eq(accountGroups.accountId, user.accountId));
      if (groups.length) await db.delete(accountGroupMembers).where(and(
        eq(accountGroupMembers.userId, userId), inArray(accountGroupMembers.groupId, groups.map(g => g.id)),
      ));
      invalidateIamCacheForUser(userId);
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
      const groups = await db.select({ groupId: accountGroups.groupId }).from(accountGroups)
        .where(and(eq(accountGroups.accountId, user.accountId), inArray(accountGroups.groupId, groupIds)));
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

function userChanges(body: Record<string, unknown>, patch = false): Map<string, unknown> {
  const changes = new Map<string, unknown>();
  const set = (key: string, value: unknown, remove = false) => {
    const attr = key.toLowerCase();
    if (['schemas', 'id', 'meta', 'groups'].includes(attr)) return;
    const emailPath = attr.match(/^emails\[type\s+eq\s+"([^"]+)"\]\.(value|primary)$/i);
    const optional = ['externalid', 'name', 'name.givenname', 'name.familyname', 'name.formatted', 'displayname', 'title', 'emails'];
    if (!['active', 'username', ...optional].includes(attr) && !emailPath) throw new Error(`Unsupported user attribute: ${key}`);
    if (remove) {
      if (!optional.includes(attr)) throw new Error(`Cannot remove user attribute: ${key}`);
      value = null;
    }
    if (attr === 'active' && typeof value === 'string') {
      const normalized = value.toLowerCase();
      if (normalized === 'false') value = false;
      if (normalized === 'true') value = true;
    }
    if (attr === 'active' && typeof value !== 'boolean') throw new Error('active must be a boolean');
    if (attr === 'username' && (typeof value !== 'string' || !value.trim() || value.trim().length > 255)) {
      throw new Error('userName must contain 1 to 255 characters');
    }
    if (attr === 'name' && value !== null) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('name must be an attribute object');
      for (const [sub, field] of Object.entries(value)) set(`name.${sub}`, field);
      return;
    }
    if ((['externalid', 'displayname', 'title'].includes(attr) || attr.startsWith('name.') || emailPath?.[2] === 'value') && value !== null && typeof value !== 'string') {
      throw new Error(`${key} must be a string or null`);
    }
    if (emailPath?.[2] === 'primary' && typeof value !== 'boolean') throw new Error('email primary must be a boolean');
    if (attr === 'emails' && value !== null && (!Array.isArray(value) || value.some(e => !e || typeof e.value !== 'string'))) {
      throw new Error('emails must be an array of email values');
    }
    changes.delete(attr);
    changes.set(attr, value);
  };
  if (patch) {
    if (!Array.isArray(body.Operations) || body.Operations.length === 0) throw new Error('Operations must be a nonempty array');
    for (const operation of body.Operations) {
      if (!operation || typeof operation !== 'object') throw new Error('Invalid PATCH operation');
      const op = typeof operation.op === 'string' ? operation.op.toLowerCase() : '';
      if (!['replace', 'add', 'remove'].includes(op)) throw new Error('Unsupported user PATCH operation');
      if (typeof operation.path === 'string' && operation.path) set(operation.path, operation.value, op === 'remove');
      else if (operation.path === undefined && op !== 'remove' && operation.value && typeof operation.value === 'object' && !Array.isArray(operation.value)) {
        for (const [key, value] of Object.entries(operation.value)) set(key, value);
      } else throw new Error('A pathless PATCH operation requires an attribute object');
    }
  } else {
    for (const [key, value] of Object.entries(body)) set(key, value);
  }
  return changes;
}

function applyProfile(user: DirectoryUser, changes: Map<string, unknown>): DirectoryUser {
  const profile = { ...user.profile };
  for (const [key, value] of changes) {
    const emailPath = key.match(/^emails\[type\s+eq\s+"([^"]+)"\]\.(value|primary)$/i);
    if (key === 'name') profile.name = value;
    if (key.startsWith('name.')) {
      const sub = ({ givenname: 'givenName', familyname: 'familyName', formatted: 'formatted' } as Record<string, string>)[key.slice(5)]!;
      profile.name = { ...(profile.name as Record<string, unknown> ?? {}), [sub]: value };
    }
    if (key === 'displayname') profile.displayName = value;
    if (key === 'title') profile.title = value;
    if (key === 'emails') profile.emails = value ?? [];
    if (emailPath) {
      const emails = [...(profile.emails as Array<Record<string, unknown>> ?? [])];
      const index = emails.findIndex(e => typeof e.type === 'string' && e.type.toLowerCase() === emailPath[1]);
      if (index < 0) emails.push({ type: emailPath[1], [emailPath[2]!]: value });
      else emails[index] = { ...emails[index], [emailPath[2]!]: value };
      profile.emails = emails;
    }
  }
  return {
    ...user, profile,
    userName: changes.has('username') ? (changes.get('username') as string).trim().toLowerCase() : user.userName,
    externalId: changes.has('externalid') ? changes.get('externalid') as string | null : user.externalId,
  };
}

const userParams = z.object({ accountId: z.string().uuid(), userId: z.string().uuid() });

scimRouter.openapi(createRoute({
  method: 'get', path: '/accounts/{accountId}/Users', tags: ['scim'],
  summary: 'List SCIM Users (filter by userName/id/externalId eq)',
  request: { params: z.object({ accountId: z.string().uuid() }), query: ScimListQuery },
  responses: { 200: json(ScimResource, 'SCIM ListResponse'), ...errors(400, 401, 403) },
}), async (c: any) => {
  const accountId = c.req.param('accountId');
  const rawFilter = c.req.query('filter');
  if (isUnsupportedFilter(rawFilter)) return scimError(c, 400, 'Unsupported filter');
  const filter = parseFilter(rawFilter);
  const recorded = await db.select().from(accountScimUsers).where(eq(accountScimUsers.accountId, accountId));
  const members = await db.select({
    userId: accountMembers.userId, scimExternalId: accountMembers.scimExternalId, joinedAt: accountMembers.joinedAt,
  }).from(accountMembers).where(eq(accountMembers.accountId, accountId));
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
  method: 'get', path: '/accounts/{accountId}/Users/{userId}', tags: ['scim'], summary: 'Get a SCIM User',
  request: { params: userParams }, responses: { 200: json(ScimResource, 'SCIM User'), ...errors(400, 401, 403, 404) },
}), async (c: any) => {
  const user = await resolveDirectoryUser(c.req.param('accountId'), c.req.param('userId'));
  return user && !user.deletedAt ? c.json(buildDirectoryUser(user)) : scimError(c, 404, 'User not found in this account');
});

scimRouter.openapi(createRoute({
  method: 'post', path: '/accounts/{accountId}/Users', tags: ['scim'], summary: 'Create / provision a SCIM User',
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

for (const method of ['patch', 'put'] as const) {
  scimRouter.openapi(createRoute({
    method, path: '/accounts/{accountId}/Users/{userId}', tags: ['scim'],
    summary: method === 'patch' ? 'Patch a SCIM User' : 'Replace a SCIM User',
    request: { params: userParams, body: { content: { 'application/json': { schema: ScimResource } } } },
    responses: { 200: json(ScimResource, 'SCIM User'), 204: { description: 'Already absent' }, ...errors(400, 401, 403, 404, 409) },
  }), writeUser);
}

scimRouter.openapi(createRoute({
  method: 'delete', path: '/accounts/{accountId}/Users/{userId}', tags: ['scim'], summary: 'Delete / deprovision a SCIM User',
  request: { params: userParams }, responses: { 204: { description: 'Deleted / idempotent' }, ...errors(400, 401, 403, 409) },
}), async (c: any) => {
  const user = await resolveDirectoryUser(c.req.param('accountId'), c.req.param('userId'));
  if (!user || user.deletedAt) return c.body(null, 204);
  const result = await applyDirectoryState(c, user, false, true);
  return result instanceof Response ? result : c.body(null, 204);
});
