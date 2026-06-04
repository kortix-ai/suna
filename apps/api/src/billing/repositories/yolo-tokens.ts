import { and, eq, isNull } from 'drizzle-orm';
import { yoloMemberTokens } from '@kortix/db';
import { db } from '../../shared/db';

export async function getActiveYoloTokenRow(userId: string, accountId: string) {
  const [row] = await db
    .select()
    .from(yoloMemberTokens)
    .where(
      and(
        eq(yoloMemberTokens.userId, userId),
        eq(yoloMemberTokens.accountId, accountId),
        isNull(yoloMemberTokens.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function revokeYoloToken(userId: string, accountId: string): Promise<void> {
  await db
    .update(yoloMemberTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(yoloMemberTokens.userId, userId), eq(yoloMemberTokens.accountId, accountId)));
}
