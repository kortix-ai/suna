import { and, eq } from 'drizzle-orm';
import { yoloMemberTokens } from '@kortix/db';
import { db } from '../../shared/db';

export async function revokeYoloToken(userId: string, accountId: string): Promise<void> {
  await db
    .update(yoloMemberTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(yoloMemberTokens.userId, userId), eq(yoloMemberTokens.accountId, accountId)));
}
