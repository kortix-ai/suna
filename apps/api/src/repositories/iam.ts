// Data-access layer for the IAM tables: groups, group members, policies, and
// system/custom role lookups. Pure CRUD — no permission checks here. Route
// handlers do their own `assertAuthorized` calls before invoking these.

import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountGroups,
  accountMembers,
  iamPolicies,
  iamRolePermissions,
  iamRoles,
} from '@kortix/db';
import { db } from '../shared/db';
import type { ResourceType } from '../iam/actions';

// ─── Groups ────────────────────────────────────────────────────────────────

export type AccountGroup = {
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
      policyCount: number;
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
      memberCount: sql<number>`(
        SELECT COUNT(*)::int FROM kortix.account_group_members
        WHERE group_id = ${accountGroups.groupId}
      )`,
      policyCount: sql<number>`(
        SELECT COUNT(*)::int FROM kortix.iam_policies
        WHERE principal_type = 'group' AND principal_id = ${accountGroups.groupId}
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

export type GroupMember = {
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

// ─── Roles ─────────────────────────────────────────────────────────────────

export type IamRole = {
  roleId: string;
  accountId: string | null;
  key: string;
  name: string;
  description: string | null;
  resourceType: ResourceType;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * List every role available to the account: system roles (accountId NULL)
 * plus any custom roles owned by the account.
 */
export async function listRoles(accountId: string): Promise<IamRole[]> {
  const rows = await db
    .select()
    .from(iamRoles)
    .where(or(isNull(iamRoles.accountId), eq(iamRoles.accountId, accountId)))
    .orderBy(asc(iamRoles.resourceType), asc(iamRoles.name));
  return rows.map((r) => ({ ...r, resourceType: r.resourceType as ResourceType }));
}

export async function getRoleById(accountId: string, roleId: string): Promise<IamRole | null> {
  const [row] = await db
    .select()
    .from(iamRoles)
    .where(
      and(
        eq(iamRoles.roleId, roleId),
        or(isNull(iamRoles.accountId), eq(iamRoles.accountId, accountId)),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { ...row, resourceType: row.resourceType as ResourceType };
}

export async function getRolePermissions(roleId: string): Promise<string[]> {
  const rows = await db
    .select({ action: iamRolePermissions.action })
    .from(iamRolePermissions)
    .where(eq(iamRolePermissions.roleId, roleId));
  return rows.map((r) => r.action);
}

// ─── Policies ──────────────────────────────────────────────────────────────

export type IamPolicy = {
  policyId: string;
  accountId: string;
  principalType: 'member' | 'group' | 'token';
  principalId: string;
  scopeType: ResourceType;
  scopeId: string | null;
  roleId: string;
  effect: 'allow' | 'deny';
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PolicyFilter = {
  principalType?: 'member' | 'group' | 'token';
  principalId?: string;
  scopeType?: ResourceType;
  scopeId?: string | null;
};

export async function listPolicies(
  accountId: string,
  filter: PolicyFilter = {},
): Promise<IamPolicy[]> {
  const conditions = [eq(iamPolicies.accountId, accountId)];
  if (filter.principalType) {
    conditions.push(eq(iamPolicies.principalType, filter.principalType));
  }
  if (filter.principalId) {
    conditions.push(eq(iamPolicies.principalId, filter.principalId));
  }
  if (filter.scopeType) {
    conditions.push(eq(iamPolicies.scopeType, filter.scopeType));
  }
  if (filter.scopeId !== undefined) {
    conditions.push(
      filter.scopeId === null
        ? isNull(iamPolicies.scopeId)
        : eq(iamPolicies.scopeId, filter.scopeId),
    );
  }

  const rows = await db
    .select()
    .from(iamPolicies)
    .where(and(...conditions))
    .orderBy(asc(iamPolicies.createdAt));
  return rows.map((r) => ({
    ...r,
    principalType: r.principalType as IamPolicy['principalType'],
    scopeType: r.scopeType as ResourceType,
    effect: r.effect as IamPolicy['effect'],
  }));
}

export async function createPolicy(args: {
  accountId: string;
  principalType: 'member' | 'group' | 'token';
  principalId: string;
  scopeType: ResourceType;
  scopeId: string | null;
  roleId: string;
  effect?: 'allow' | 'deny';
  createdBy: string;
}): Promise<IamPolicy> {
  // The DB CHECK constraint already enforces that scope_type='account' has
  // scope_id NULL. Belt-and-braces: normalise here so callers can't pass a
  // bad combo.
  const normalisedScopeId = args.scopeType === 'account' ? null : args.scopeId;
  const effect = args.effect ?? 'allow';

  const [row] = await db
    .insert(iamPolicies)
    .values({
      accountId: args.accountId,
      principalType: args.principalType,
      principalId: args.principalId,
      scopeType: args.scopeType,
      scopeId: normalisedScopeId,
      roleId: args.roleId,
      effect,
      createdBy: args.createdBy,
    })
    .onConflictDoNothing()
    .returning();

  // If a duplicate was suppressed, fetch the existing row so the caller
  // always gets a consistent result.
  if (!row) {
    const [existing] = await db
      .select()
      .from(iamPolicies)
      .where(
        and(
          eq(iamPolicies.accountId, args.accountId),
          eq(iamPolicies.principalType, args.principalType),
          eq(iamPolicies.principalId, args.principalId),
          eq(iamPolicies.scopeType, args.scopeType),
          normalisedScopeId === null
            ? isNull(iamPolicies.scopeId)
            : eq(iamPolicies.scopeId, normalisedScopeId),
          eq(iamPolicies.roleId, args.roleId),
          eq(iamPolicies.effect, effect),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new Error('failed to create policy and no duplicate found');
    }
    return {
      ...existing,
      principalType: existing.principalType as IamPolicy['principalType'],
      scopeType: existing.scopeType as ResourceType,
      effect: existing.effect as IamPolicy['effect'],
    };
  }

  return {
    ...row,
    principalType: row.principalType as IamPolicy['principalType'],
    scopeType: row.scopeType as ResourceType,
    effect: row.effect as IamPolicy['effect'],
  };
}

export async function deletePolicy(accountId: string, policyId: string): Promise<boolean> {
  const rows = await db
    .delete(iamPolicies)
    .where(and(eq(iamPolicies.accountId, accountId), eq(iamPolicies.policyId, policyId)))
    .returning({ policyId: iamPolicies.policyId });
  return rows.length > 0;
}
