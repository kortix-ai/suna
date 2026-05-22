// Keeps IAM policies in sync with membership changes so the engine never needs
// the legacy account_role / project_members bridges. Every place that adds a
// member, changes a role, or grants project access calls one of these.
//
// Model:
//   owner  → account_members.is_super_admin = true (super-admin bypass; no policy)
//   admin  → Administrator policy @ account
//   member → Member baseline policy @ account
//   project manager/editor/viewer → project_{admin,editor,viewer} policy @ project

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { accountMembers, iamPolicies, iamRoles } from '@kortix/db';
import { db } from '../shared/db';
import { createPolicy } from '../repositories/iam';
import { SYSTEM_ROLE_KEY } from './system-roles';

type RoleIds = {
  administrator: string;
  member: string;
  projectAdmin: string;
  projectEditor: string;
  projectViewer: string;
};

let cached: RoleIds | null = null;

async function roleIds(): Promise<RoleIds | null> {
  if (cached) return cached;
  const rows = await db
    .select({ key: iamRoles.key, roleId: iamRoles.roleId })
    .from(iamRoles)
    .where(
      and(
        isNull(iamRoles.accountId),
        inArray(iamRoles.key, [
          SYSTEM_ROLE_KEY.ADMINISTRATOR,
          SYSTEM_ROLE_KEY.MEMBER,
          SYSTEM_ROLE_KEY.PROJECT_ADMIN,
          SYSTEM_ROLE_KEY.PROJECT_EDITOR,
          SYSTEM_ROLE_KEY.PROJECT_VIEWER,
        ]),
      ),
    );
  const byKey = new Map(rows.map((r) => [r.key, r.roleId]));
  const ids: RoleIds = {
    administrator: byKey.get(SYSTEM_ROLE_KEY.ADMINISTRATOR)!,
    member: byKey.get(SYSTEM_ROLE_KEY.MEMBER)!,
    projectAdmin: byKey.get(SYSTEM_ROLE_KEY.PROJECT_ADMIN)!,
    projectEditor: byKey.get(SYSTEM_ROLE_KEY.PROJECT_EDITOR)!,
    projectViewer: byKey.get(SYSTEM_ROLE_KEY.PROJECT_VIEWER)!,
  };
  if (Object.values(ids).some((v) => !v)) return null; // roles not seeded yet
  cached = ids;
  return ids;
}

/** Drop a member's account-scope baseline/admin policies (both effects, the
 *  two system roles). Used before re-assigning, on remove, and on role change. */
async function clearAccountScopePolicies(accountId: string, userId: string, ids: RoleIds) {
  await db
    .delete(iamPolicies)
    .where(
      and(
        eq(iamPolicies.accountId, accountId),
        eq(iamPolicies.principalType, 'member'),
        eq(iamPolicies.principalId, userId),
        eq(iamPolicies.scopeType, 'account'),
        inArray(iamPolicies.roleId, [ids.administrator, ids.member]),
      ),
    );
}

/**
 * Make the member's account-scope policy + super-admin flag match `accountRole`.
 * Handles every transition (add, promote, demote). Idempotent.
 */
export async function syncMemberAccountPolicy(args: {
  accountId: string;
  userId: string;
  accountRole: 'owner' | 'admin' | 'member';
  createdBy?: string;
}): Promise<void> {
  const ids = await roleIds();
  if (!ids) return;
  const { accountId, userId, accountRole } = args;

  await clearAccountScopePolicies(accountId, userId, ids);

  if (accountRole === 'owner') {
    await db
      .update(accountMembers)
      .set({ isSuperAdmin: true })
      .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));
    return;
  }

  // Demoting away from owner drops the super-admin grant that ownership implied.
  await db
    .update(accountMembers)
    .set({ isSuperAdmin: false })
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));

  await createPolicy({
    accountId,
    principalType: 'member',
    principalId: userId,
    scopeType: 'account',
    scopeId: null,
    roleId: accountRole === 'admin' ? ids.administrator : ids.member,
    effect: 'allow',
    createdBy: args.createdBy ?? userId,
  });
}

/** Remove all of a member's policies in an account (on remove / leave). */
export async function removeMemberPolicies(accountId: string, userId: string): Promise<void> {
  await db
    .delete(iamPolicies)
    .where(
      and(
        eq(iamPolicies.accountId, accountId),
        eq(iamPolicies.principalType, 'member'),
        eq(iamPolicies.principalId, userId),
      ),
    );
}

/** Ensure a project-scoped policy matching `projectRole` (manager/editor/viewer). */
export async function syncProjectMemberPolicy(args: {
  accountId: string;
  projectId: string;
  userId: string;
  projectRole: 'manager' | 'editor' | 'viewer';
  createdBy?: string;
}): Promise<void> {
  const ids = await roleIds();
  if (!ids) return;
  const { accountId, projectId, userId, projectRole } = args;

  // Clear any existing project-scoped policy for this member on this project.
  await db
    .delete(iamPolicies)
    .where(
      and(
        eq(iamPolicies.accountId, accountId),
        eq(iamPolicies.principalType, 'member'),
        eq(iamPolicies.principalId, userId),
        eq(iamPolicies.scopeType, 'project'),
        eq(iamPolicies.scopeId, projectId),
        inArray(iamPolicies.roleId, [ids.projectAdmin, ids.projectEditor, ids.projectViewer]),
      ),
    );

  const roleId =
    projectRole === 'manager'
      ? ids.projectAdmin
      : projectRole === 'editor'
        ? ids.projectEditor
        : ids.projectViewer;

  await createPolicy({
    accountId,
    principalType: 'member',
    principalId: userId,
    scopeType: 'project',
    scopeId: projectId,
    roleId,
    effect: 'allow',
    createdBy: args.createdBy ?? userId,
  });
}

/** Remove ALL of a member's project-scoped policies in an account. Used when a
 *  member is promoted to owner/admin (they gain implicit access to every
 *  project, so explicit per-project grants are dropped). */
export async function removeProjectPoliciesForMember(
  accountId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(iamPolicies)
    .where(
      and(
        eq(iamPolicies.accountId, accountId),
        eq(iamPolicies.principalType, 'member'),
        eq(iamPolicies.principalId, userId),
        eq(iamPolicies.scopeType, 'project'),
      ),
    );
}

/** Remove a member's project-scoped policy for a project (on access revoke). */
export async function removeProjectMemberPolicy(
  accountId: string,
  projectId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(iamPolicies)
    .where(
      and(
        eq(iamPolicies.accountId, accountId),
        eq(iamPolicies.principalType, 'member'),
        eq(iamPolicies.principalId, userId),
        eq(iamPolicies.scopeType, 'project'),
        eq(iamPolicies.scopeId, projectId),
      ),
    );
}
