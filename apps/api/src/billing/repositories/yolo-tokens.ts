import { Effect } from 'effect';
import { and, eq, isNull } from 'drizzle-orm';
import { yoloMemberTokens } from '@kortix/db';
import { DatabaseService } from '../../effect/services';
import { runEffectOrThrow } from '../../effect/http';

export async function getActiveYoloTokenRow(userId: string, accountId: string) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const [row] = yield* Effect.tryPromise(() =>
      database
        .select()
        .from(yoloMemberTokens)
        .where(
          and(
            eq(yoloMemberTokens.userId, userId),
            eq(yoloMemberTokens.accountId, accountId),
            isNull(yoloMemberTokens.revokedAt),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  }));
}

export async function revokeYoloToken(userId: string, accountId: string): Promise<void> {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    yield* Effect.tryPromise(() =>
      database
        .update(yoloMemberTokens)
        .set({ revokedAt: new Date().toISOString() })
        .where(and(eq(yoloMemberTokens.userId, userId), eq(yoloMemberTokens.accountId, accountId))),
    );
  }));
}
