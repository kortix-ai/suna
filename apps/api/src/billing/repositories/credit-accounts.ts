import { creditAccounts } from '@kortix/db';
import { Effect } from 'effect';
import { and, eq, isNull, lte, ne, or } from 'drizzle-orm';
import { DatabaseService } from '../../effect/services';
import { runEffectOrThrow } from '../../effect/http';

export async function getCreditAccount(accountId: string) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const [row] = yield* Effect.tryPromise(() =>
      database
        .select()
        .from(creditAccounts)
        .where(eq(creditAccounts.accountId, accountId))
        .limit(1),
    );

    return row ?? null;
  }));
}

export async function getCreditBalance(accountId: string) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const [row] = yield* Effect.tryPromise(() =>
      database
        .select({
          balance: creditAccounts.balance,
          expiringCredits: creditAccounts.expiringCredits,
          nonExpiringCredits: creditAccounts.nonExpiringCredits,
          dailyCreditsBalance: creditAccounts.dailyCreditsBalance,
          tier: creditAccounts.tier,
        })
        .from(creditAccounts)
        .where(eq(creditAccounts.accountId, accountId))
        .limit(1),
    );

    return row ?? null;
  }));
}

export async function getSubscriptionInfo(accountId: string) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const [row] = yield* Effect.tryPromise(() =>
      database
        .select({
          tier: creditAccounts.tier,
          provider: creditAccounts.provider,
          planType: creditAccounts.planType,
          stripeSubscriptionId: creditAccounts.stripeSubscriptionId,
          stripeSubscriptionStatus: creditAccounts.stripeSubscriptionStatus,
          trialStatus: creditAccounts.trialStatus,
          trialEndsAt: creditAccounts.trialEndsAt,
          commitmentType: creditAccounts.commitmentType,
          commitmentEndDate: creditAccounts.commitmentEndDate,
          scheduledTierChange: creditAccounts.scheduledTierChange,
          scheduledTierChangeDate: creditAccounts.scheduledTierChangeDate,
          scheduledPriceId: creditAccounts.scheduledPriceId,
          billingCycleAnchor: creditAccounts.billingCycleAnchor,
          nextCreditGrant: creditAccounts.nextCreditGrant,
          lastDailyRefresh: creditAccounts.lastDailyRefresh,
          paymentStatus: creditAccounts.paymentStatus,
          revenuecatCustomerId: creditAccounts.revenuecatCustomerId,
          revenuecatSubscriptionId: creditAccounts.revenuecatSubscriptionId,
          revenuecatProductId: creditAccounts.revenuecatProductId,
          revenuecatPendingChangeProduct: creditAccounts.revenuecatPendingChangeProduct,
          revenuecatPendingChangeDate: creditAccounts.revenuecatPendingChangeDate,
          revenuecatPendingChangeType: creditAccounts.revenuecatPendingChangeType,
          revenuecatCancelledAt: creditAccounts.revenuecatCancelledAt,
          revenuecatCancelAtPeriodEnd: creditAccounts.revenuecatCancelAtPeriodEnd,
          // Billing v2 — per-seat fields surfaced for the account-state response.
          billingModel: creditAccounts.billingModel,
          seatCount: creditAccounts.seatCount,
          seatSubscriptionItemId: creditAccounts.seatSubscriptionItemId,
          autoTopupCustomized: creditAccounts.autoTopupCustomized,
        })
        .from(creditAccounts)
        .where(eq(creditAccounts.accountId, accountId))
        .limit(1),
    );

    return row ?? null;
  }));
}

export async function upsertCreditAccount(
  accountId: string,
  data: Partial<typeof creditAccounts.$inferInsert>,
) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const now = new Date().toISOString();

    yield* Effect.tryPromise(() =>
      database
        .insert(creditAccounts)
        .values({ accountId, ...data, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: creditAccounts.accountId,
          set: { ...data, updatedAt: now },
        }),
    );
  }));
}

export async function updateCreditAccount(
  accountId: string,
  data: Partial<typeof creditAccounts.$inferInsert>,
) {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    yield* Effect.tryPromise(() =>
      database
        .update(creditAccounts)
        .set({ ...data, updatedAt: new Date().toISOString() })
        .where(eq(creditAccounts.accountId, accountId)),
    );
  }));
}

export async function getYearlyAccountsDueForRotation() {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const now = new Date().toISOString();

    return yield* Effect.tryPromise(() =>
      database
        .select()
        .from(creditAccounts)
        .where(
          and(
            eq(creditAccounts.planType, 'yearly'),
            ne(creditAccounts.tier, 'free'),
            eq(creditAccounts.stripeSubscriptionStatus, 'active'),
            ne(creditAccounts.paymentStatus, 'past_due'),
            or(isNull(creditAccounts.nextCreditGrant), lte(creditAccounts.nextCreditGrant, now)),
          ),
        ),
    );
  }));
}

export async function getFreeAccountsDueForRotation() {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const now = new Date().toISOString();

    return yield* Effect.tryPromise(() =>
      database
        .select()
        .from(creditAccounts)
        .where(
          and(
            eq(creditAccounts.tier, 'free'),
            or(isNull(creditAccounts.nextCreditGrant), lte(creditAccounts.nextCreditGrant, now)),
          ),
        ),
    );
  }));
}
