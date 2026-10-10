/**
 * The Capture tenant: one workspace per Kortix account. Capture has no project
 * in its model. A workspace row carries the account-level switch (`enabled`)
 * and the policy; `capture_members` overrides a person's Capture role.
 *
 * Roles. Default from the account role: owner/admin → `admin`, member →
 * `member`. A `capture_members` row overrides it.
 *   admin   every member's devices and timeline (each read audited), the
 *           policy, the members, the switch.
 *   viewer  every member's devices and timeline (each read audited), no writes.
 *   member  their own devices and timeline only.
 */
import { accounts, captureMembers, captureWorkspaces } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { accountMemberRow } from '../iam/membership-read';
import { accountRoleFor, accountRoleMap, accountRolesForUser, type AccountRoleKey } from '../iam/read-models';
import { db } from '../shared/db';
import { DEFAULT_POLICY, PolicySchema, type CapturePolicy } from './format';

export type CaptureRole = 'admin' | 'viewer' | 'member';
export const CAPTURE_ROLES: readonly CaptureRole[] = ['admin', 'viewer', 'member'];

export function defaultCaptureRole(accountRole: AccountRoleKey): CaptureRole {
  return accountRole === 'owner' || accountRole === 'admin' ? 'admin' : 'member';
}

/** True for a role that may read other members' data. */
export function readsEveryone(role: CaptureRole): boolean {
  return role === 'admin' || role === 'viewer';
}

export interface Workspace {
  accountId: string;
  enabled: boolean;
  policy: CapturePolicy;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export async function readWorkspace(accountId: string): Promise<Workspace> {
  const [row] = await db.select().from(captureWorkspaces).where(eq(captureWorkspaces.accountId, accountId)).limit(1);
  if (!row) return { accountId, enabled: false, policy: DEFAULT_POLICY, updatedAt: null, updatedBy: null };
  return {
    accountId,
    enabled: row.enabled,
    policy: Object.keys(row.policy).length ? PolicySchema.parse(row.policy) : DEFAULT_POLICY,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export async function captureEnabled(accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: captureWorkspaces.enabled })
    .from(captureWorkspaces)
    .where(eq(captureWorkspaces.accountId, accountId))
    .limit(1);
  return row?.enabled ?? false;
}

/** Turn Capture on or off for an account. */
export async function setCaptureEnabled(accountId: string, enabled: boolean, userId: string): Promise<Workspace> {
  await db
    .insert(captureWorkspaces)
    .values({ accountId, enabled, updatedBy: userId })
    .onConflictDoUpdate({ target: captureWorkspaces.accountId, set: { enabled, updatedBy: userId, updatedAt: sql`now()` } });
  return readWorkspace(accountId);
}

/** A person's Capture role in an account, or null when they are not a member of it. */
export async function captureRole(accountId: string, userId: string): Promise<CaptureRole | null> {
  const accountRole = await accountRoleFor(accountId, userId);
  if (!accountRole) return null;
  const [override] = await db
    .select({ role: captureMembers.role })
    .from(captureMembers)
    .where(and(eq(captureMembers.accountId, accountId), eq(captureMembers.userId, userId)))
    .limit(1);
  return (override?.role as CaptureRole | undefined) ?? defaultCaptureRole(accountRole);
}

export interface CaptureMember {
  user_id: string;
  account_role: AccountRoleKey;
  role: CaptureRole;
  /** True when the role comes from a `capture_members` row, not the account role. */
  overridden: boolean;
}

/** Every account member with their effective Capture role. */
export async function listCaptureMembers(accountId: string): Promise<CaptureMember[]> {
  const roles = await accountRoleMap(accountId);
  const overrides = new Map(
    (await db.select().from(captureMembers).where(eq(captureMembers.accountId, accountId))).map((row) => [
      row.userId,
      row.role as CaptureRole,
    ]),
  );
  return [...roles].map(([userId, accountRole]) => ({
    user_id: userId,
    account_role: accountRole,
    role: overrides.get(userId) ?? defaultCaptureRole(accountRole),
    overridden: overrides.has(userId),
  }));
}

/** Set a person's Capture role, or clear the override (null) back to the account-role default. */
export async function setCaptureMemberRole(
  accountId: string,
  userId: string,
  role: CaptureRole | null,
  grantedBy: string,
): Promise<void> {
  if (role === null) {
    await db.delete(captureMembers).where(and(eq(captureMembers.accountId, accountId), eq(captureMembers.userId, userId)));
    return;
  }
  await db
    .insert(captureMembers)
    .values({ accountId, userId, role, grantedBy })
    .onConflictDoUpdate({
      target: [captureMembers.accountId, captureMembers.userId],
      set: { role, grantedBy, updatedAt: sql`now()` },
    });
}

/** The accounts a person belongs to where Capture is on (device sign-in picks one). */
export async function captureAccountsFor(userId: string): Promise<Array<{ account_id: string; name: string }>> {
  const memberOf = [...(await accountRolesForUser(userId)).keys()];
  if (memberOf.length === 0) return [];
  return db
    .select({ account_id: accounts.accountId, name: accounts.name })
    .from(captureWorkspaces)
    .innerJoin(accounts, eq(accounts.accountId, captureWorkspaces.accountId))
    .where(and(inArray(captureWorkspaces.accountId, memberOf), eq(captureWorkspaces.enabled, true)))
    .orderBy(accounts.name);
}

/** True when the person is still a member of the account (devices of former members stop). */
export async function isAccountMember(accountId: string, userId: string): Promise<boolean> {
  const [row] = await accountMemberRow(accountId, userId);
  return Boolean(row);
}
