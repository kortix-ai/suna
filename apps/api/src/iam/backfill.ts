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

/**
 * Backfill ONE account. Same logic as the global pass but constrained
 * to a single account_id so an admin can mirror their account's legacy
 * project_members → IAM policies on demand (e.g. before flipping
 * strict mode). Returns the row counts inserted at each stage so the
 * UI can render a "mirrored 12 admins, 41 project grants" toast.
 */
export async function backfillAccountMembershipPolicies(
  accountId: string,
): Promise<{
  ownersPromoted: number;
  adminsMirrored: number;
  membersMirrored: number;
  projectMembersMirrored: number;
}> {
  const [adminId, memberId, projAdminId, projEditorId, projViewerId] = await Promise.all([
    systemRoleId(SYSTEM_ROLE_KEY.ADMINISTRATOR),
    systemRoleId(SYSTEM_ROLE_KEY.MEMBER),
    systemRoleId(SYSTEM_ROLE_KEY.PROJECT_ADMIN),
    systemRoleId(SYSTEM_ROLE_KEY.PROJECT_EDITOR),
    systemRoleId(SYSTEM_ROLE_KEY.PROJECT_VIEWER),
  ]);
  if (!adminId || !memberId || !projAdminId || !projEditorId || !projViewerId) {
    throw new Error('system roles not seeded — cannot backfill');
  }

  // Owners → super-admin promotion. Already-super-admin owners get
  // returned as a 0-row update by Postgres; count reflects new flips.
  const owners = await db.execute<{ promoted: number }>(sql`
    WITH updated AS (
      UPDATE kortix.account_members
      SET is_super_admin = true
      WHERE account_id = ${accountId}::uuid
        AND account_role = 'owner'
        AND is_super_admin = false
      RETURNING user_id
    )
    SELECT COUNT(*)::int AS promoted FROM updated
  `);
  const ownersRows = ((owners as unknown) as { rows: Array<{ promoted: number }> }).rows ?? owners;

  const admins = await db.execute<{ inserted: number }>(sql`
    WITH inserted AS (
      INSERT INTO kortix.iam_policies
        (account_id, principal_type, principal_id, scope_type, scope_id, role_id, effect)
      SELECT am.account_id, 'member', am.user_id, 'account', NULL, ${adminId}::uuid, 'allow'
      FROM kortix.account_members am
      WHERE am.account_id = ${accountId}::uuid AND am.account_role = 'admin'
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT COUNT(*)::int AS inserted FROM inserted
  `);
  const adminsRows = ((admins as unknown) as { rows: Array<{ inserted: number }> }).rows ?? admins;

  const members = await db.execute<{ inserted: number }>(sql`
    WITH inserted AS (
      INSERT INTO kortix.iam_policies
        (account_id, principal_type, principal_id, scope_type, scope_id, role_id, effect)
      SELECT am.account_id, 'member', am.user_id, 'account', NULL, ${memberId}::uuid, 'allow'
      FROM kortix.account_members am
      WHERE am.account_id = ${accountId}::uuid AND am.account_role = 'member'
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT COUNT(*)::int AS inserted FROM inserted
  `);
  const membersRows = ((members as unknown) as { rows: Array<{ inserted: number }> }).rows ?? members;

  const projectMembers = await db.execute<{ inserted: number }>(sql`
    WITH inserted AS (
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
      WHERE pm.account_id = ${accountId}::uuid
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT COUNT(*)::int AS inserted FROM inserted
  `);
  const pmRows = ((projectMembers as unknown) as { rows: Array<{ inserted: number }> }).rows
    ?? projectMembers;

  return {
    ownersPromoted: ownersRows[0]?.promoted ?? 0,
    adminsMirrored: adminsRows[0]?.inserted ?? 0,
    membersMirrored: membersRows[0]?.inserted ?? 0,
    projectMembersMirrored: pmRows[0]?.inserted ?? 0,
  };
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
