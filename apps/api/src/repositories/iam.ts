// Data-access layer for the IAM tables. Currently scoped to groups and
// group members; historical policy / role / role-permission CRUD is not
// part of the active IAM V2 surface.
// Pure CRUD; route handlers do their own assertAuthorized() calls.

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { accountGroupMembers, accountGroups, accountMembers } from '@kortix/db';
import { db } from '../shared/db';

// ─── Groups ────────────────────────────────────────────────────────────────

type AccountGroup = {
  groupId: string;
  accountId: string;
  name: string;
  description: string | null;
  source: 'manual' | 'scim';
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function listGroups(accountId: string): Promise<
  Array<
    AccountGroup & {
      memberCount: number;
      /** Number of project_group_grants attaching this group to a project. */
      projectCount: number;
    }
  >
> {
  const rows = await db
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

  return rows.map((r) => ({
    ...r,
    source: r.source as 'manual' | 'scim',
  }));
}

export async function getGroup(accountId: string, groupId: string): Promise<AccountGroup | null> {
  const [row] = await db
    .select()
    .from(accountGroups)
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.groupId, groupId)))
    .limit(1);
  if (!row) return null;
  return { ...row, source: row.source as 'manual' | 'scim' };
}

export async function createGroup(args: {
  accountId: string;
  name: string;
  description?: string | null;
  createdBy: string;
}): Promise<AccountGroup> {
  const [row] = await db
    .insert(accountGroups)
    .values({
      accountId: args.accountId,
      name: args.name,
      description: args.description ?? null,
      createdBy: args.createdBy,
    })
    .returning();
  return { ...row, source: row.source as 'manual' | 'scim' };
}

export async function updateGroup(
  accountId: string,
  groupId: string,
  patch: { name?: string; description?: string | null },
): Promise<AccountGroup | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.description !== undefined) updates.description = patch.description;
  const [row] = await db
    .update(accountGroups)
    .set(updates)
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.groupId, groupId)))
    .returning();
  if (!row) return null;
  return { ...row, source: row.source as 'manual' | 'scim' };
}

export async function deleteGroup(accountId: string, groupId: string): Promise<boolean> {
  const rows = await db
    .delete(accountGroups)
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.groupId, groupId)))
    .returning({ groupId: accountGroups.groupId });
  return rows.length > 0;
}

// ─── Group members ─────────────────────────────────────────────────────────

type GroupMember = {
  groupId: string;
  userId: string;
  addedAt: Date;
  addedBy: string | null;
};

export async function listGroupMembers(
  accountId: string,
  groupId: string,
): Promise<GroupMember[]> {
  // Ensure the group belongs to the account before returning members.
  const [group] = await db
    .select({ groupId: accountGroups.groupId })
    .from(accountGroups)
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.groupId, groupId)))
    .limit(1);
  if (!group) return [];

  return db
    .select({
      groupId: accountGroupMembers.groupId,
      userId: accountGroupMembers.userId,
      addedAt: accountGroupMembers.addedAt,
      addedBy: accountGroupMembers.addedBy,
    })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.groupId, groupId))
    .orderBy(asc(accountGroupMembers.addedAt));
}

export async function addGroupMembers(args: {
  accountId: string;
  groupId: string;
  userIds: string[];
  addedBy: string;
}): Promise<{ added: number }> {
  if (args.userIds.length === 0) return { added: 0 };

  // All requested users must be members of the account; silently drop the rest.
  const validRows = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, args.accountId),
        inArray(accountMembers.userId, args.userIds),
      ),
    );
  const valid = new Set(validRows.map((r) => r.userId));
  const filtered = args.userIds.filter((u) => valid.has(u));
  if (filtered.length === 0) return { added: 0 };

  const inserted = await db
    .insert(accountGroupMembers)
    .values(
      filtered.map((userId) => ({
        groupId: args.groupId,
        userId,
        addedBy: args.addedBy,
      })),
    )
    .onConflictDoNothing()
    .returning({ userId: accountGroupMembers.userId });
  return { added: inserted.length };
}

export async function removeGroupMember(
  groupId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .delete(accountGroupMembers)
    .where(and(eq(accountGroupMembers.groupId, groupId), eq(accountGroupMembers.userId, userId)))
    .returning({ userId: accountGroupMembers.userId });
  return rows.length > 0;
}

/**
 * Groups a specific user belongs to within an account. Reverse of
 * listGroupMembers — backs the "this member has these powers via groups"
 * section on the member detail page.
 */
export async function listGroupsForMember(
  accountId: string,
  userId: string,
): Promise<Array<{ groupId: string; name: string; addedAt: Date }>> {
  return db
    .select({
      groupId: accountGroups.groupId,
      name: accountGroups.name,
      addedAt: accountGroupMembers.addedAt,
    })
    .from(accountGroupMembers)
    .innerJoin(accountGroups, eq(accountGroups.groupId, accountGroupMembers.groupId))
    .where(
      and(eq(accountGroups.accountId, accountId), eq(accountGroupMembers.userId, userId)),
    )
    .orderBy(asc(accountGroups.name));
}
