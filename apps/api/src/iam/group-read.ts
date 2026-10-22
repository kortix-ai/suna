// Read model of account groups: `kortix.account_groups` and
// `kortix.group_members`. Every group read outside iam/ goes through here.
//
// Each function returns the query its caller ran inline, unexecuted and
// verbatim (see membership-read.ts): same statements, same order. Two
// functions that differ only in predicate order stay two.
import { accountGroupMembers, accountGroups, accountMembers } from '@kortix/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../shared/db';

/** The ids of every group the user is in, across accounts. */
export function groupIdsOfUser(userId: string) {
  return db
    .select({ groupId: accountGroupMembers.groupId })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.userId, userId));
}

/** The user ids in one group. */
export function groupMemberUserIds(groupId: string) {
  return db
    .select({ userId: accountGroupMembers.userId })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.groupId, groupId));
}

/** `(groupId, userId)` pairs of the groups. */
export function groupMemberRows(groupIds: string[]) {
  return db
    .select({ groupId: accountGroupMembers.groupId, userId: accountGroupMembers.userId })
    .from(accountGroupMembers)
    .where(inArray(accountGroupMembers.groupId, groupIds));
}

/** Every (user, group, group name) membership of the account's groups. */
export function accountGroupMembershipRows(accountId: string) {
  return db
    .select({
      userId: accountGroupMembers.userId,
      groupId: accountGroups.groupId,
      name: accountGroups.name,
    })
    .from(accountGroupMembers)
    .innerJoin(accountGroups, eq(accountGroupMembers.groupId, accountGroups.groupId))
    .where(eq(accountGroups.accountId, accountId));
}

/** The members of the groups that are in the account, with the super-admin flag. */
export function groupMemberAccountRows(accountId: string, groupIds: string[]) {
  return db
    .select({
      groupId: accountGroupMembers.groupId,
      isSuperAdmin: accountMembers.isSuperAdmin,
      userId: accountMembers.userId,
    })
    .from(accountGroupMembers)
    .innerJoin(
      accountMembers,
      and(
        eq(accountMembers.userId, accountGroupMembers.userId),
        eq(accountMembers.accountId, accountId),
      ),
    )
    .where(inArray(accountGroupMembers.groupId, groupIds));
}

/** The account's SCIM-sourced groups the user is in. */
export function scimGroupIdsOfUser(accountId: string, userId: string) {
  return db.select({ groupId: accountGroups.groupId }).from(accountGroups)
    .innerJoin(accountGroupMembers, eq(accountGroupMembers.groupId, accountGroups.groupId))
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.source, 'scim'), eq(accountGroupMembers.userId, userId)));
}

/** A group's members, oldest first, at most `cap` rows. */
export function groupMemberListRows(groupId: string, cap: number) {
  return db
    .select({
      groupId: accountGroupMembers.groupId,
      userId: accountGroupMembers.userId,
      addedAt: accountGroupMembers.addedAt,
      addedBy: accountGroupMembers.addedBy,
    })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.groupId, groupId))
    .orderBy(asc(accountGroupMembers.addedAt))
    .limit(cap);
}

/** The account's groups the user is in, by name. */
export function groupsForMemberRows(accountId: string, userId: string) {
  return db
    .select({
      groupId: accountGroups.groupId,
      name: accountGroups.name,
      addedAt: accountGroupMembers.addedAt,
    })
    .from(accountGroupMembers)
    .innerJoin(accountGroups, eq(accountGroups.groupId, accountGroupMembers.groupId))
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroupMembers.userId, userId)))
    .orderBy(asc(accountGroups.name));
}

/** The account's groups by name, with member and project counts. */
export function accountGroupListRows(accountId: string) {
  return db
    .select({
      groupId: accountGroups.groupId,
      accountId: accountGroups.accountId,
      name: accountGroups.name,
      description: accountGroups.description,
      source: accountGroups.source,
      externalId: accountGroups.externalId,
      createdAt: accountGroups.createdAt,
      updatedAt: accountGroups.updatedAt,
      // IMPORTANT: hard-code the outer table reference in these correlated
      // subqueries. Drizzle's ${accountGroups.groupId} interpolation emits
      // the bare "group_id" without a table prefix, so Postgres resolves
      // both sides of `WHERE x.group_id = "group_id"` to the inner alias
      // and the filter degenerates to `WHERE TRUE` — counts come back as
      // table-wide totals. Aliasing the inner table doesn't help; we need
      // the OUTER reference to be unambiguously kortix.account_groups.
      memberCount: sql<number>`(
        SELECT COUNT(*)::int FROM kortix.account_group_members agm
        WHERE agm.group_id = kortix.account_groups.group_id
      )`,
      projectCount: sql<number>`(
        SELECT COUNT(*)::int FROM kortix.project_group_grants pgg
        WHERE pgg.group_id = kortix.account_groups.group_id
      )`,
    })
    .from(accountGroups)
    .where(eq(accountGroups.accountId, accountId))
    .orderBy(asc(accountGroups.name));
}

/** The full group row, when the group is in the account. */
export function accountGroupFullRow(accountId: string, groupId: string) {
  return db
    .select()
    .from(accountGroups)
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.groupId, groupId)))
    .limit(1);
}

/** `{ groupId }` when the group is in the account (account predicate first). */
export function accountGroupRow(accountId: string, groupId: string) {
  return db
    .select({ groupId: accountGroups.groupId })
    .from(accountGroups)
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.groupId, groupId)))
    .limit(1);
}

/** `{ groupId }` when the group is in the account (group predicate first). */
export function groupInAccountRow(groupId: string, accountId: string) {
  return db
    .select({ groupId: accountGroups.groupId })
    .from(accountGroups)
    .where(and(eq(accountGroups.groupId, groupId), eq(accountGroups.accountId, accountId)))
    .limit(1);
}

/** `{ groupId, name }` when the group is in the account. */
export function accountGroupNameRow(accountId: string, groupId: string) {
  return db
    .select({ groupId: accountGroups.groupId, name: accountGroups.name })
    .from(accountGroups)
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.groupId, groupId)))
    .limit(1);
}

/** `{ name }` of the group, when it is in the account. */
export function groupNameInAccountRow(accountId: string, groupId: string) {
  return db
    .select({ name: accountGroups.name })
    .from(accountGroups)
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.groupId, groupId)))
    .limit(1);
}

/** The ids of every group of the account. */
export function accountGroupIds(accountId: string) {
  return db
    .select({ groupId: accountGroups.groupId })
    .from(accountGroups)
    .where(eq(accountGroups.accountId, accountId));
}

/** Id and name of every group of the account. */
export function accountGroupNames(accountId: string) {
  return db
    .select({ groupId: accountGroups.groupId, name: accountGroups.name })
    .from(accountGroups)
    .where(eq(accountGroups.accountId, accountId));
}

/** The groups of `groupIds` that are in the account. */
export function accountGroupsAmong(accountId: string, groupIds: string[]) {
  return db
    .select({ groupId: accountGroups.groupId })
    .from(accountGroups)
    .where(and(eq(accountGroups.accountId, accountId), inArray(accountGroups.groupId, groupIds)));
}

/** Id and name of the groups of `groupIds` that are in the account. */
export function accountGroupNamesAmong(accountId: string, groupIds: string[]) {
  return db
    .select({ groupId: accountGroups.groupId, name: accountGroups.name })
    .from(accountGroups)
    .where(and(eq(accountGroups.accountId, accountId), inArray(accountGroups.groupId, groupIds)));
}

/** Id and name of the groups, in any account. */
export function groupNamesByIds(groupIds: string[]) {
  return db
    .select({ groupId: accountGroups.groupId, name: accountGroups.name })
    .from(accountGroups)
    .where(inArray(accountGroups.groupId, groupIds));
}

/** The account's SSO-sourced group with this name. */
export function ssoGroupByNameRow(accountId: string, name: string) {
  return db
    .select({ groupId: accountGroups.groupId })
    .from(accountGroups)
    .where(
      and(
        eq(accountGroups.accountId, accountId),
        eq(accountGroups.name, name),
        eq(accountGroups.source, 'sso'),
      ),
    )
    .limit(1);
}

/** The SCIM wire fields of every group of the account. */
export function scimGroupRows(accountId: string) {
  return db
    .select({
      groupId: accountGroups.groupId,
      name: accountGroups.name,
      externalId: accountGroups.externalId,
      createdAt: accountGroups.createdAt,
      updatedAt: accountGroups.updatedAt,
    })
    .from(accountGroups)
    .where(eq(accountGroups.accountId, accountId));
}

/** The SCIM wire fields of one group of the account. */
export function scimGroupRow(accountId: string, groupId: string) {
  return db
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
}

/** The SCIM wire fields of one group, by id alone. */
export function scimGroupRowById(groupId: string) {
  return db
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
}
