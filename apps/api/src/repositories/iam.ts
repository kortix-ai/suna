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
import type { PolicyConditions } from '../iam/engine';

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

/**
 * Create a custom (account-scoped, non-system) role with its initial action
 * set in a single transaction. Throws if (accountId, key) collides — the
 * route layer maps that to a 409. `key`, `name`, `resourceType`, and
 * `actions` must already be validated by the caller (route handler).
 */
export async function createCustomRole(args: {
  accountId: string;
  key: string;
  name: string;
  description: string | null;
  resourceType: ResourceType;
  actions: string[];
}): Promise<IamRole> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(iamRoles)
      .values({
        accountId: args.accountId,
        key: args.key,
        name: args.name,
        description: args.description,
        resourceType: args.resourceType,
        isSystem: false,
      })
      .returning();
    if (args.actions.length > 0) {
      await tx
        .insert(iamRolePermissions)
        .values(args.actions.map((action) => ({ roleId: row.roleId, action })));
    }
    return { ...row, resourceType: row.resourceType as ResourceType };
  });
}

/**
 * Update a custom role's mutable fields. `key` is intentionally immutable —
 * existing policies reference the role by id (not key) but tooling, audit
 * logs, and external mentions assume keys are stable. resourceType is also
 * immutable because changing it would invalidate every policy that scoped
 * a target of the old type.
 */
export async function updateCustomRole(
  accountId: string,
  roleId: string,
  patch: { name?: string; description?: string | null },
): Promise<IamRole | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.description !== undefined) updates.description = patch.description;

  const [row] = await db
    .update(iamRoles)
    .set(updates)
    .where(
      and(
        eq(iamRoles.roleId, roleId),
        // The accountId guard prevents anyone from editing a system role
        // (which has account_id IS NULL) via this code path.
        eq(iamRoles.accountId, accountId),
      ),
    )
    .returning();
  if (!row) return null;
  return { ...row, resourceType: row.resourceType as ResourceType };
}

/**
 * Replace the action set of a custom role wholesale. Diffs in memory then
 * issues one INSERT and one DELETE so the bus carries minimal traffic and
 * concurrent updates can't shuffle the set into an intermediate state.
 */
export async function replaceRolePermissions(
  accountId: string,
  roleId: string,
  actions: string[],
): Promise<{ updated: boolean; added: number; removed: number }> {
  // Verify the role exists AND belongs to this account before touching
  // permissions — protects against tampering with system roles (NULL
  // accountId never matches a real accountId).
  const [role] = await db
    .select({ roleId: iamRoles.roleId })
    .from(iamRoles)
    .where(and(eq(iamRoles.roleId, roleId), eq(iamRoles.accountId, accountId)))
    .limit(1);
  if (!role) return { updated: false, added: 0, removed: 0 };

  const desired = new Set(actions);
  const current = await db
    .select({ action: iamRolePermissions.action })
    .from(iamRolePermissions)
    .where(eq(iamRolePermissions.roleId, roleId));
  const have = new Set(current.map((r) => r.action));

  const toAdd = [...desired].filter((a) => !have.has(a));
  const toRemove = [...have].filter((a) => !desired.has(a));

  await db.transaction(async (tx) => {
    if (toAdd.length > 0) {
      await tx
        .insert(iamRolePermissions)
        .values(toAdd.map((action) => ({ roleId, action })))
        .onConflictDoNothing();
    }
    if (toRemove.length > 0) {
      await tx.execute(sql`
        DELETE FROM kortix.iam_role_permissions
        WHERE role_id = ${roleId}
          AND action IN (${sql.join(toRemove.map((a) => sql`${a}`), sql`, `)})
      `);
    }
    // Touch updated_at on the role so audit ordering reflects the change.
    await tx
      .update(iamRoles)
      .set({ updatedAt: new Date() })
      .where(eq(iamRoles.roleId, roleId));
  });

  return { updated: true, added: toAdd.length, removed: toRemove.length };
}

/**
 * Delete a custom role. The DB schema has ON DELETE RESTRICT on
 * iam_policies.role_id, so a role currently referenced by any policy will
 * raise a foreign-key error — the route maps that to a 409 with a clear
 * message. Returns null if the role doesn't exist or is a system role.
 */
export async function deleteCustomRole(
  accountId: string,
  roleId: string,
): Promise<boolean> {
  const rows = await db
    .delete(iamRoles)
    .where(and(eq(iamRoles.roleId, roleId), eq(iamRoles.accountId, accountId)))
    .returning({ roleId: iamRoles.roleId });
  return rows.length > 0;
}

/** Count policies still referencing a role — used by the delete-warning UI. */
export async function countPoliciesUsingRole(
  accountId: string,
  roleId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(iamPolicies)
    .where(and(eq(iamPolicies.accountId, accountId), eq(iamPolicies.roleId, roleId)));
  return row?.n ?? 0;
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
  /** Optional gating conditions evaluated at request time. Empty object
   *  means "always applies". See PolicyConditions for shape. */
  conditions: PolicyConditions;
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
    conditions: (r.conditions ?? {}) as PolicyConditions,
  }));
}

/**
 * Single-row policy fetch by id. Used by the audit log to snapshot the
 * pre-state of update/delete events.
 */
export async function getPolicyById(
  accountId: string,
  policyId: string,
): Promise<IamPolicy | null> {
  const [row] = await db
    .select()
    .from(iamPolicies)
    .where(and(eq(iamPolicies.accountId, accountId), eq(iamPolicies.policyId, policyId)))
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    principalType: row.principalType as IamPolicy['principalType'],
    scopeType: row.scopeType as ResourceType,
    effect: row.effect as IamPolicy['effect'],
    conditions: (row.conditions ?? {}) as PolicyConditions,
  };
}

export async function createPolicy(args: {
  accountId: string;
  principalType: 'member' | 'group' | 'token';
  principalId: string;
  scopeType: ResourceType;
  scopeId: string | null;
  roleId: string;
  effect?: 'allow' | 'deny';
  /** Optional gating conditions. Omit / empty object = always applies. */
  conditions?: PolicyConditions;
  createdBy: string;
}): Promise<IamPolicy> {
  // The DB CHECK constraint already enforces that scope_type='account' has
  // scope_id NULL. Belt-and-braces: normalise here so callers can't pass a
  // bad combo.
  const normalisedScopeId = args.scopeType === 'account' ? null : args.scopeId;
  const effect = args.effect ?? 'allow';
  const conditions = args.conditions ?? {};

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
      conditions: conditions as Record<string, unknown>,
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
      conditions: (existing.conditions ?? {}) as PolicyConditions,
    };
  }

  return {
    ...row,
    principalType: row.principalType as IamPolicy['principalType'],
    scopeType: row.scopeType as ResourceType,
    effect: row.effect as IamPolicy['effect'],
    conditions: (row.conditions ?? {}) as PolicyConditions,
  };
}

export async function deletePolicy(accountId: string, policyId: string): Promise<boolean> {
  const rows = await db
    .delete(iamPolicies)
    .where(and(eq(iamPolicies.accountId, accountId), eq(iamPolicies.policyId, policyId)))
    .returning({ policyId: iamPolicies.policyId });
  return rows.length > 0;
}

/**
 * Mutate an existing policy. Only role, scope, and effect can change —
 * principal is immutable (a policy is defined by who it grants to). The
 * caller must validate role/scope compatibility before invoking.
 *
 * Returns null if no policy with that id exists in the account.
 * Throws on unique-constraint conflict (a different policy already exists
 * with the same (principal, scope, role, effect)).
 */
export async function updatePolicy(
  accountId: string,
  policyId: string,
  patch: {
    scopeType: ResourceType;
    scopeId: string | null;
    roleId: string;
    effect: 'allow' | 'deny';
    /** When set, replaces the whole conditions object (no partial merge).
     *  Omit to leave existing conditions untouched. */
    conditions?: PolicyConditions;
  },
): Promise<IamPolicy | null> {
  const normalisedScopeId = patch.scopeType === 'account' ? null : patch.scopeId;

  const updates: Record<string, unknown> = {
    scopeType: patch.scopeType,
    scopeId: normalisedScopeId,
    roleId: patch.roleId,
    effect: patch.effect,
    updatedAt: new Date(),
  };
  if (patch.conditions !== undefined) updates.conditions = patch.conditions;

  const [row] = await db
    .update(iamPolicies)
    .set(updates)
    .where(and(eq(iamPolicies.accountId, accountId), eq(iamPolicies.policyId, policyId)))
    .returning();

  if (!row) return null;
  return {
    ...row,
    principalType: row.principalType as IamPolicy['principalType'],
    scopeType: row.scopeType as ResourceType,
    effect: row.effect as IamPolicy['effect'],
    conditions: (row.conditions ?? {}) as PolicyConditions,
  };
}
