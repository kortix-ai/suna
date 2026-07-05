import { accountMembers } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';

export async function resolveProjectAutomationActor(accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.accountRole, 'owner'),
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}
