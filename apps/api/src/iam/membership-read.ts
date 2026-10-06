// Read model of the account directory: `kortix.account_members` (the view)
// and `kortix.account_memberships` (the table). Every membership read outside
// iam/ goes through here, so one module decides who is in an account.
//
// Each function returns the query its caller ran inline, unexecuted and
// verbatim: the caller awaits it where it awaited the inline query, so every
// request sends the same statements in the same order. Two functions that
// differ only in predicate order stay two, because the order is in the SQL.
import { accountMembers, accountMemberships, accounts, iamRoles, roleAssignments } from '@kortix/db';
import { type SQL, and, asc, count, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../shared/db';

/** The accounts a user belongs to, with the fields the account switcher shows. */
export function userAccountRows(userId: string) {
  return db
    .select({
      accountId: accountMembers.accountId,
      name: accounts.name,
      createdAt: accounts.createdAt,
      updatedAt: accounts.updatedAt,
      branding: accounts.branding,
    })
    .from(accountMembers)
    .innerJoin(accounts, eq(accountMembers.accountId, accounts.accountId))
    .where(eq(accountMembers.userId, userId));
}

/** The accounts a user belongs to, id and name only. */
export function userAccountNameRows(userId: string) {
  return db
    .select({
      accountId: accountMembers.accountId,
      name: accounts.name,
    })
    .from(accountMembers)
    .innerJoin(accounts, eq(accountMembers.accountId, accounts.accountId))
    .where(eq(accountMembers.userId, userId));
}

/**
 * Member count EXCLUDING phantom self-memberships: a row where user_id ==
 * account_id whose user_id is not a real auth user. A personal account's
 * owner also has user_id == account_id but IS a real auth user, so the NOT
 * EXISTS keeps it. Needs the auth schema.
 */
export function countBillableAccountMembers(accountId: string) {
  return db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM kortix.account_members am
      WHERE am.account_id = ${accountId}::uuid
        AND NOT (
          am.user_id = am.account_id
          AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = am.user_id)
        )
    `);
}

/** Every directory row of an account, counted. */
export function countAccountMembers(accountId: string) {
  return db
    .select({ n: count() })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId));
}

/** `{ userId }` when the user is in the account (account predicate first). */
export function accountMemberRow(accountId: string, userId: string) {
  return db.select({ userId: accountMembers.userId }).from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId))).limit(1);
}

/** `{ userId }` when the user is in the account (user predicate first). */
export function userAccountMemberRow(userId: string, accountId: string) {
  return db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);
}

/** `{ accountId }` when the user is in the account. */
export function userAccountMembershipRow(userId: string, accountId: string) {
  return db
    .select({ accountId: accountMembers.accountId })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);
}

/** Any one account the user belongs to (no order). */
export function anyAccountMembershipOf(userId: string) {
  return db
    .select({ accountId: accountMembers.accountId })
    .from(accountMembers)
    .where(eq(accountMembers.userId, userId))
    .limit(1);
}

/** Every member's user id. */
export function accountMemberUserIds(accountId: string) {
  return db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId));
}

/** The users of `userIds` that are members of the account. */
export function accountMembersAmong(accountId: string, userIds: string[]) {
  return db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), inArray(accountMembers.userId, userIds)));
}

/** The member list: who is here, the super-admin bypass flag, and since when. */
export function accountDirectoryRows(accountId: string) {
  return db
    .select({
      userId: accountMembers.userId,
      isSuperAdmin: accountMembers.isSuperAdmin,
      joinedAt: accountMembers.joinedAt,
    })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId));
}

/** Who is in the account, and when they joined. */
export function accountMemberJoinRows(accountId: string) {
  return db
    .select({
      userId: accountMembers.userId,
      joinedAt: accountMembers.joinedAt,
    })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId));
}

/** SCIM's view of every member: identity, IdP external id, join date. */
export function scimMemberRows(accountId: string) {
  return db.select({
    userId: accountMembers.userId, scimExternalId: accountMembers.scimExternalId, joinedAt: accountMembers.joinedAt,
  }).from(accountMembers).where(eq(accountMembers.accountId, accountId));
}

/** SCIM's view of one member. */
export function scimMemberRow(accountId: string, userId: string) {
  return db
    .select({
      userId: accountMembers.userId,
      scimExternalId: accountMembers.scimExternalId,
      joinedAt: accountMembers.joinedAt,
    })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
    .limit(1);
}

/** The accounts whose `account_members.account_role` names the user owner. */
export function ownedAccountRows(userId: string) {
  return db
    .select({ accountId: accountMembers.accountId })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountRole, 'owner')));
}

/** One super-admin of the account, if any. */
export function accountSuperAdminRow(accountId: string) {
  return db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.isSuperAdmin, true),
      ),
    )
    .limit(1);
}

/** Every member with its role, super-admin flag and verified MFA factor count. */
export function accountMemberMfaRows(accountId: string) {
  return db.execute<{
      user_id: string;
      account_role: string;
      is_super_admin: boolean;
      verified_factors: number;
    }>(sql`
    SELECT
      am.user_id::text AS user_id,
      am.account_role::text AS account_role,
      am.is_super_admin,
      COALESCE((
        SELECT COUNT(*)::int FROM auth.mfa_factors mf
        WHERE mf.user_id = am.user_id AND mf.status = 'verified'
      ), 0) AS verified_factors
    FROM kortix.account_members am
    WHERE am.account_id = ${accountId}::uuid
  `);
}

/** One member with a verified MFA factor, if any. */
export function accountMfaEnrolledMemberRow(accountId: string) {
  return db.execute<{ user_id: string }>(sql`
        SELECT am.user_id
        FROM kortix.account_members am
        WHERE am.account_id = ${accountId}::uuid
          AND EXISTS (
            SELECT 1 FROM auth.mfa_factors mf
            WHERE mf.user_id = am.user_id AND mf.status = 'verified'
          )
        LIMIT 1
      `);
}

/** The members of an account with a verified MFA factor. */
export function verifiedMfaMemberIds(accountId: string) {
  return db.execute<{ user_id: string }>(sql`
      SELECT DISTINCT user_id::text
      FROM auth.mfa_factors
      WHERE status = 'verified'
        AND user_id IN (
          SELECT user_id FROM kortix.account_members WHERE account_id = ${accountId}::uuid
        )
    `);
}

/**
 * The live `owner` role holders of the accounts, earliest-joined first. The
 * ROLE comes from `role_assignments`; `account_members.joined_at` is identity.
 */
export function accountOwnersByJoinDate(accountIds: string[]) {
  return db
    .select({ accountId: accountMembers.accountId, userId: accountMembers.userId })
    .from(accountMembers)
    .innerJoin(
      roleAssignments,
      and(
        eq(roleAssignments.accountId, accountMembers.accountId),
        eq(roleAssignments.principalType, 'user'),
        eq(roleAssignments.principalId, accountMembers.userId),
        eq(roleAssignments.scopeType, 'account'),
      ),
    )
    .innerJoin(
      iamRoles,
      and(
        eq(iamRoles.roleId, roleAssignments.roleId),
        isNull(iamRoles.accountId),
        eq(iamRoles.key, 'owner'),
      ),
    )
    .where(
      and(
        inArray(accountMembers.accountId, accountIds),
        or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, sql`now()`)),
      ),
    )
    .orderBy(asc(accountMembers.joinedAt));
}

/** The member's `is_super_admin` flag, from the membership table. */
export function membershipSuperAdminRow(accountId: string, userId: string) {
  return db
    .select({ isSuperAdmin: accountMemberships.isSuperAdmin })
    .from(accountMemberships)
    .where(
      and(
        eq(accountMemberships.accountId, accountId),
        eq(accountMemberships.userId, userId),
      ),
    )
    .limit(1);
}

/** `{ userId }` when the membership table has the user in the account. */
export function membershipRow(userId: string, accountId: string) {
  return db
    .select({ userId: accountMemberships.userId })
    .from(accountMemberships)
    .where(and(eq(accountMemberships.userId, userId), eq(accountMemberships.accountId, accountId)))
    .limit(1);
}

/** SQL predicate: the membership table has `userId` in `accountId`. */
export function membershipExistsSql(userId: SQL, accountId: string): SQL {
  return sql`exists (select 1 from kortix.account_memberships m where m.user_id = ${userId} and m.account_id = ${accountId})`;
}

/** SQL predicate: the directory has the row's user in the row's account (correlated columns). */
export function accountMemberExistsSql(userIdColumn: SQL, accountIdColumn: SQL): SQL {
  return sql`exists (select 1 from kortix.account_members m
                      where m.user_id = ${userIdColumn} and m.account_id = ${accountIdColumn})`;
}

/** One row when `uid` belongs to the account that owns the project. */
export function projectAccountMembershipRows(projectId: string, uid: string) {
  return db.execute<{ found: number }>(sql`
    select 1 as found from kortix.account_memberships m
      join kortix.projects p on p.account_id = m.account_id
     where p.project_id = ${projectId}::uuid and m.user_id::text = ${uid}
     limit 1`);
}

/**
 * The trusted auth user an email names, a member of `accountId` first.
 * `trusted` is the caller's email-trust predicate over alias `u`.
 */
export function userIdByEmailRows(normalizedEmail: string, accountId: string | undefined, trusted: SQL) {
  return db.execute(sql`
    SELECT u.id::text AS id
    FROM auth.users u
    LEFT JOIN kortix.account_memberships m
      ON m.user_id = u.id AND m.account_id = ${accountId ?? null}::uuid
    WHERE u.email = ${normalizedEmail}
      AND ${trusted}
    ORDER BY (m.user_id IS NOT NULL) DESC, u.created_at, u.id
    LIMIT 1
  `);
}

/**
 * Scalar subquery: the PRIMARY owner's email of the account in
 * `accountIdColumn`. The personal-account owner first (`user_id = account_id`),
 * then the earliest-joined owner, then the email.
 */
export function accountPrimaryOwnerEmailSql(accountIdColumn: SQL) {
  return sql<string | null>`(
      SELECT au.email FROM auth.users au
      INNER JOIN kortix.account_members am ON am.user_id = au.id
      WHERE am.account_id = ${accountIdColumn}
      ORDER BY (am.user_id = ${accountIdColumn}) DESC,
               CASE am.account_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               am.joined_at ASC, au.email ASC
      LIMIT 1)`;
}

/** Scalar subquery: the member count of the account in `accountIdColumn`. */
export function accountMemberCountSql(accountIdColumn: SQL) {
  return sql<number>`(
      SELECT count(*)::int FROM kortix.account_members am WHERE am.account_id = ${accountIdColumn})`;
}

/** SQL predicate: a member of the account in `accountIdColumn` has an email ILIKE `pattern`. */
export function accountHasMemberEmailLikeSql(accountIdColumn: SQL, pattern: string): SQL {
  return sql`EXISTS (SELECT 1 FROM auth.users au INNER JOIN kortix.account_members am ON am.user_id = au.id
                      WHERE am.account_id = ${accountIdColumn} AND au.email ILIKE ${pattern})`;
}

/**
 * Subquery: the account ids with a member whose email ILIKEs `pattern`.
 * Users-first by force: the LATERAL + `offset 0` fence pins one pass over
 * auth.users, then one `account_members_pkey` probe per matching user (see
 * admin/accounts-search.ts).
 */
export function accountIdsWithMemberEmailLikeSql(pattern: string): SQL {
  return sql`SELECT m.account_id FROM auth.users au
    JOIN LATERAL (SELECT am.account_id FROM kortix.account_members am
                  WHERE am.user_id = au.id OFFSET 0) m ON true
    WHERE au.email ILIKE ${pattern}`;
}

/** The account's members with their auth identity, owners first (admin console). */
export function accountMemberAuthRows(accountId: string) {
  return db.execute(sql`
      SELECT au.id AS user_id, au.email,
             am.account_role AS account_role,
             au.created_at AS signed_up_at,
             au.last_sign_in_at AS last_sign_in_at,
             au.email_confirmed_at AS email_confirmed_at,
             au.banned_until AS banned_until,
             au.raw_app_meta_data->>'provider' AS provider,
             au.raw_app_meta_data->'providers' AS providers
      FROM kortix.account_members am
      INNER JOIN auth.users au ON au.id = am.user_id
      WHERE am.account_id = ${accountId}
      ORDER BY CASE am.account_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, au.email ASC`);
}

/**
 * `innerJoin` arguments that keep a row only while `userId` is in `accountId`:
 * `.innerJoin(...accountMemberJoin(accountId, userId))`.
 */
export function accountMemberJoin(accountId: string, userId: string) {
  return [accountMembers, and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId))] as const;
}
