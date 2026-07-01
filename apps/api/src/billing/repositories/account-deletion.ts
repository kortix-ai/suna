import { Effect } from 'effect';
import { eq, and, lte } from 'drizzle-orm';
import { accountDeletionRequests } from '@kortix/db';
import { DatabaseService } from '../../effect/services';
import { runEffectOrThrow } from '../../effect/http';

export async function getActiveDeletionRequest(accountId: string) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const [row] = yield* Effect.tryPromise(() =>
      database
        .select()
        .from(accountDeletionRequests)
        .where(
          and(
            eq(accountDeletionRequests.accountId, accountId),
            eq(accountDeletionRequests.status, 'pending'),
          ),
        )
        .limit(1),
    );

    return row ?? null;
  }));
}

export async function createDeletionRequest(
  accountId: string,
  userId: string,
  scheduledFor: string,
  reason?: string,
) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const [row] = yield* Effect.tryPromise(() =>
      database
        .insert(accountDeletionRequests)
        .values({
          accountId,
          userId,
          scheduledFor,
          reason: reason ?? null,
          status: 'pending',
        })
        .returning(),
    );

    return row;
  }));
}

export async function cancelDeletionRequest(requestId: string) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    yield* Effect.tryPromise(() =>
      database
        .update(accountDeletionRequests)
        .set({
          status: 'cancelled',
          cancelledAt: new Date().toISOString(),
        })
        .where(eq(accountDeletionRequests.id, requestId)),
    );
  }));
}

export async function markDeletionCompleted(requestId: string) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    yield* Effect.tryPromise(() =>
      database
        .update(accountDeletionRequests)
        .set({
          status: 'completed',
          completedAt: new Date().toISOString(),
        })
        .where(eq(accountDeletionRequests.id, requestId)),
    );
  }));
}

export async function getScheduledDeletions() {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const now = new Date().toISOString();
    return yield* Effect.tryPromise(() =>
      database
        .select()
        .from(accountDeletionRequests)
        .where(
          and(
            eq(accountDeletionRequests.status, 'pending'),
            lte(accountDeletionRequests.scheduledFor, now),
          ),
        ),
    );
  }));
}
