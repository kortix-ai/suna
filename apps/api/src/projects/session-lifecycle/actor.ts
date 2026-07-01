import type { Effect } from 'effect';
import { accountMembers } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { sharedDb as db } from '../../shared/effect';

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
