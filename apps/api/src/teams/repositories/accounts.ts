import { and, eq } from 'drizzle-orm';
import { accountMembers, type Database } from '@kortix/db';
import type { AccountRole, Membership } from '../domain/types';

export async function listUserMemberships(
  db: Database,
  userId: string,
): Promise<Membership[]> {
  const rows = await db
    .select({ accountId: accountMembers.accountId, role: accountMembers.accountRole })
    .from(accountMembers)
    .where(eq(accountMembers.userId, userId));
  return rows.map((r) => ({ accountId: r.accountId, role: r.role }));
}

export async function getAccountRole(
  db: Database,
  userId: string,
  accountId: string,
): Promise<AccountRole | null> {
  const [row] = await db
    .select({ role: accountMembers.accountRole })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);
  return row?.role ?? null;
}

export async function ensureAccountMember(
  db: Database,
  userId: string,
  accountId: string,
  role: AccountRole = 'member',
): Promise<void> {
  await db
    .insert(accountMembers)
    .values({ userId, accountId, accountRole: role })
    .onConflictDoNothing();
}

export async function listAccountMembers(
  db: Database,
  accountId: string,
): Promise<Array<{ userId: string; role: AccountRole }>> {
  const rows = await db
    .select({ userId: accountMembers.userId, role: accountMembers.accountRole })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId));
  return rows.map((r) => ({ userId: r.userId, role: r.role }));
}

export async function updateAccountRole(
  db: Database,
  userId: string,
  accountId: string,
  role: AccountRole,
): Promise<number> {
  const result = await db
    .update(accountMembers)
    .set({ accountRole: role })
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)));
  const anyResult = result as any;
  return anyResult?.count ?? anyResult?.rowCount ?? 0;
}
