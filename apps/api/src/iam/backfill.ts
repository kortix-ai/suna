// Backfill legacy account_role + project_members into explicit IAM policies.
//
// This is the cut-over that lets the engine drop the legacy bridges: every
// existing membership is materialised as a real policy so authorize() can
// decide purely from super-admin + policies. Idempotent (ON CONFLICT DO
// NOTHING against the iam_policies unique indexes), so it is safe to run on
// every boot — it only ever inserts the rows that don't exist yet.
//
//   owner   → is_super_admin = true (covered by the super-admin bypass)
//   admin   → Administrator policy @ account (Everything)
//   member  → Member baseline policy @ account (Everything)
//   project_members.{manager,editor,viewer} → project_{admin,editor,viewer} @ that project

import { and, eq, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { accountMembers, iamRoles } from '@kortix/db';
import { db } from '../shared/db';
import { SYSTEM_ROLE_KEY } from './system-roles';

async function systemRoleId(key: string): Promise<string | null> {
  const [r] = await db
    .select({ roleId: iamRoles.roleId })
    .from(iamRoles)
    .where(and(isNull(iamRoles.accountId), eq(iamRoles.key, key)))
    .limit(1);
  return r?.roleId ?? null;
}

export async function backfillMembershipPolicies(): Promise<void> {
  const [adminId, memberId, projAdminId, projEditorId, projViewerId] = await Promise.all([
    systemRoleId(SYSTEM_ROLE_KEY.ADMINISTRATOR),
    systemRoleId(SYSTEM_ROLE_KEY.MEMBER),
    systemRoleId(SYSTEM_ROLE_KEY.PROJECT_ADMIN),
    systemRoleId(SYSTEM_ROLE_KEY.PROJECT_EDITOR),
    systemRoleId(SYSTEM_ROLE_KEY.PROJECT_VIEWER),
  ]);

  if (!adminId || !memberId || !projAdminId || !projEditorId || !projViewerId) {
    console.warn('[iam-backfill] system roles not seeded yet — skipping backfill');
    return;
  }

  // 1. Owners are super-admins (the bypass covers all their access).
  await db
    .update(accountMembers)
    .set({ isSuperAdmin: true })
    .where(and(eq(accountMembers.accountRole, 'owner'), eq(accountMembers.isSuperAdmin, false)));

  // 2. Admins → Administrator @ account.
  await db.execute(sql`
    INSERT INTO kortix.iam_policies
      (account_id, principal_type, principal_id, scope_type, scope_id, role_id, effect)
    SELECT am.account_id, 'member', am.user_id, 'account', NULL, ${adminId}::uuid, 'allow'
    FROM kortix.account_members am
    WHERE am.account_role = 'admin'
    ON CONFLICT DO NOTHING
  `);

  // 3. Plain members → Member baseline @ account.
  await db.execute(sql`
    INSERT INTO kortix.iam_policies
      (account_id, principal_type, principal_id, scope_type, scope_id, role_id, effect)
    SELECT am.account_id, 'member', am.user_id, 'account', NULL, ${memberId}::uuid, 'allow'
    FROM kortix.account_members am
    WHERE am.account_role = 'member'
    ON CONFLICT DO NOTHING
  `);

  // 4. Project members → matching project role @ that project.
  await db.execute(sql`
    INSERT INTO kortix.iam_policies
      (account_id, principal_type, principal_id, scope_type, scope_id, role_id, effect)
    SELECT pm.account_id, 'member', pm.user_id, 'project', pm.project_id,
      CASE pm.project_role
        WHEN 'manager' THEN ${projAdminId}::uuid
        WHEN 'editor'  THEN ${projEditorId}::uuid
        ELSE ${projViewerId}::uuid
      END,
      'allow'
    FROM kortix.project_members pm
    ON CONFLICT DO NOTHING
  `);
}
