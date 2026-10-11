/**
 * The Capture tenant: one workspace per Kortix account. Capture has no project
 * in its model. A workspace row carries the account-level switch (`enabled`)
 * and the policy.
 *
 * Access is Kortix IAM, not a Capture table. Every account member records and
 * reads their own capture. Two account leaves reach other people:
 * `capture.read_all` (every member's devices and timeline, each read audited)
 * and `capture.manage` (the switch, the policy, revoking any device). Owner
 * and admin hold both by default; a custom role can grant either.
 */
import { accounts, captureWorkspaces } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { accountMemberRow } from '../iam/membership-read';
import { accountRolesForUser } from '../iam/read-models';
import { db } from '../shared/db';
import { DEFAULT_POLICY, PolicySchema, type CapturePolicy } from './format';

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
