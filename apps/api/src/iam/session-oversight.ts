/**
 * Account session oversight: the account-level policy that lets account OWNERS
 * and ADMINS open every session in the account, members' private ones
 * included. Stored as `accounts.admins_see_all_sessions`, off by default, and
 * changed only by an owner (`PATCH /accounts/:id/iam/session-oversight`).
 *
 * This module answers "does THIS USER hold oversight in THIS ACCOUNT". It does
 * not decide which credential may use it: `isProjectSessionVisibleTo`
 * (connectors/share.ts) refuses it to every session-bound agent/sandbox token.
 *
 * Kept out of `iam/authorize.ts` on purpose. Several route suites replace that
 * module wholesale with `mock.module`, so every new name imported from it into
 * the session paths is a name each stub would have to declare. This module
 * imports only the database layer.
 */
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { accountGroupMembers, accounts, iamRoles, roleAssignments } from '@kortix/db';
import { db } from '../shared/db';
import { ttlMemo } from '../shared/ttl-memo';

/** The account roles oversight reaches. Same set as `isImplicitManager`. */
export const OVERSIGHT_ACCOUNT_ROLES = ['owner', 'admin'] as const;

/** Pure: the verdict from the two facts it is made of. */
export function sessionOversightFrom(input: {
  policyEnabled: boolean;
  callerIsAccountAdmin: boolean;
}): boolean {
  return input.policyEnabled && input.callerIsAccountAdmin;
}

/** Read the account policy. A missing account reads as off. */
export async function readSessionOversightPolicy(accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: accounts.adminsSeeAllSessions })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  return row?.enabled === true;
}

/**
 * True when the user holds the SYSTEM owner or admin role at account scope,
 * directly or through a group — the same assignments `authorize` folds into
 * `accountRoleKey`. Custom roles never grant oversight.
 */
async function callerIsAccountAdmin(userId: string, accountId: string): Promise<boolean> {
  const memberGroups = db
    .select({ gid: accountGroupMembers.groupId })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.userId, userId));
  const [row] = await db
    .select({ roleId: roleAssignments.roleId })
    .from(roleAssignments)
    .innerJoin(iamRoles, eq(iamRoles.roleId, roleAssignments.roleId))
    .where(
      and(
        eq(roleAssignments.accountId, accountId),
        eq(roleAssignments.scopeType, 'account'),
        isNull(roleAssignments.objectType),
        isNull(iamRoles.accountId),
        inArray(iamRoles.key, [...OVERSIGHT_ACCOUNT_ROLES]),
        or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, sql`now()`)),
        or(
          and(eq(roleAssignments.principalType, 'user'), eq(roleAssignments.principalId, userId)),
          and(eq(roleAssignments.principalType, 'group'), inArray(roleAssignments.principalId, memberGroups)),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function resolveOversight(userId: string, accountId: string): Promise<boolean> {
  // The policy is off in almost every account: answer that with one indexed
  // primary-key read and skip the role lookup entirely.
  const policyEnabled = await readSessionOversightPolicy(accountId);
  if (!policyEnabled) return false;
  return sessionOversightFrom({
    policyEnabled,
    callerIsAccountAdmin: await callerIsAccountAdmin(userId, accountId),
  });
}

const TTL_MS = (() => {
  const raw = Number(process.env.IAM_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15_000;
})();

// A policy flip clears this memo on the writing replica
// (`invalidateSessionOversight`). Other replicas, and role changes, converge
// within one TTL window: the same posture as the rest of IAM.
const oversightMemo = ttlMemo({
  ttlMs: TTL_MS,
  keyFn: (userId: string, accountId: string) => `${userId}|${accountId}`,
  loader: resolveOversight,
});

/** Drop every cached verdict. Called after the policy flips. */
export function invalidateSessionOversight(): void {
  oversightMemo.clear();
}

/**
 * Does this human user hold session oversight in this account? Fails closed:
 * a lookup error answers `false`, so an outage can only hide sessions, never
 * reveal them.
 */
export async function hasAccountSessionOversight(userId: string, accountId: string): Promise<boolean> {
  if (!userId || !accountId) return false;
  try {
    return await oversightMemo(userId, accountId);
  } catch (err) {
    console.warn('[session-oversight] lookup failed; denying oversight', {
      accountId,
      err: (err as Error)?.message,
    });
    return false;
  }
}
