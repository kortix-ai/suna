import { creditAccounts } from '@kortix/db';
import { and, asc, eq, gt, isNull, lte, ne, or } from 'drizzle-orm';
import { ROTATION_BATCH_SIZE } from '../services/rotation-batch';
import { db } from '../../shared/db';

export async function getCreditAccount(accountId: string) {
  const [row] = await db
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.accountId, accountId))
    .limit(1);

  return row ?? null;
}

export async function getCreditBalance(accountId: string) {
  const [row] = await db
    .select({
      balance: creditAccounts.balance,
      expiringCredits: creditAccounts.expiringCredits,
      nonExpiringCredits: creditAccounts.nonExpiringCredits,
      dailyCreditsBalance: creditAccounts.dailyCreditsBalance,
      tier: creditAccounts.tier,
    })
    .from(creditAccounts)
    .where(eq(creditAccounts.accountId, accountId))
    .limit(1);

  return row ?? null;
}

export async function getSubscriptionInfo(accountId: string) {
  const [row] = await db
    .select({
      tier: creditAccounts.tier,
      provider: creditAccounts.provider,
      planType: creditAccounts.planType,
      stripeSubscriptionId: creditAccounts.stripeSubscriptionId,
      stripeSubscriptionStatus: creditAccounts.stripeSubscriptionStatus,
      commitmentType: creditAccounts.commitmentType,
      commitmentEndDate: creditAccounts.commitmentEndDate,
      billingCycleAnchor: creditAccounts.billingCycleAnchor,
      nextCreditGrant: creditAccounts.nextCreditGrant,
      paymentStatus: creditAccounts.paymentStatus,
      revenuecatCustomerId: creditAccounts.revenuecatCustomerId,
      revenuecatSubscriptionId: creditAccounts.revenuecatSubscriptionId,
      revenuecatProductId: creditAccounts.revenuecatProductId,
      revenuecatPendingChangeProduct: creditAccounts.revenuecatPendingChangeProduct,
      revenuecatPendingChangeDate: creditAccounts.revenuecatPendingChangeDate,
      revenuecatPendingChangeType: creditAccounts.revenuecatPendingChangeType,
      revenuecatCancelledAt: creditAccounts.revenuecatCancelledAt,
      revenuecatCancelAtPeriodEnd: creditAccounts.revenuecatCancelAtPeriodEnd,
      planMonthlyUsd: creditAccounts.planMonthlyUsd,
      // Read only by `planMonthlyUsd()`'s fallback for a per-seat row not yet backfilled.
      seatCount: creditAccounts.seatCount,
      autoTopupCustomized: creditAccounts.autoTopupCustomized,
      // The JSONB override map. Selected because callers feed this row
      // straight to `resolveBillingFromRow` (account-state.ts:96); omitting it
      // would make an override silently vanish on that path while applying
      // everywhere else.
      entitlementOverrides: creditAccounts.entitlementOverrides,
    })
    .from(creditAccounts)
    .where(eq(creditAccounts.accountId, accountId))
    .limit(1);

  return row ?? null;
}

export async function upsertCreditAccount(
  accountId: string,
  data: Partial<typeof creditAccounts.$inferInsert>,
) {
  const now = new Date().toISOString();

  await db
    .insert(creditAccounts)
    .values({ accountId, ...data, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: creditAccounts.accountId,
      set: { ...data, updatedAt: now },
    });
}

export async function updateCreditAccount(
  accountId: string,
  data: Partial<typeof creditAccounts.$inferInsert>,
) {
  await db
    .update(creditAccounts)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(creditAccounts.accountId, accountId));
}

const rotationColumns = {
  accountId: creditAccounts.accountId,
  tier: creditAccounts.tier,
  planMonthlyUsd: creditAccounts.planMonthlyUsd,
  seatCount: creditAccounts.seatCount,
  nextCreditGrant: creditAccounts.nextCreditGrant,
};

export async function getYearlyAccountsDueForRotation(afterAccountId?: string) {
  const now = new Date().toISOString();

  const rows = await db
    .select(rotationColumns)
    .from(creditAccounts)
    .where(
      and(
        afterAccountId ? gt(creditAccounts.accountId, afterAccountId) : undefined,
        // A yearly Stripe plan: paid once a year, credited monthly. Enterprise
        // is credited by its contract pool instead, and a monthly reset here
        // would wipe that pool (enterprise-contracts.ts).
        eq(creditAccounts.planType, 'yearly'),
        ne(creditAccounts.tier, 'free'),
        ne(creditAccounts.tier, 'enterprise'),
        eq(creditAccounts.stripeSubscriptionStatus, 'active'),
        ne(creditAccounts.paymentStatus, 'past_due'),
        or(isNull(creditAccounts.nextCreditGrant), lte(creditAccounts.nextCreditGrant, now)),
      ),
    )
    .orderBy(asc(creditAccounts.accountId))
    .limit(ROTATION_BATCH_SIZE);

  return rows;
}

export async function getFreeAccountsDueForRotation(afterAccountId?: string) {
  const now = new Date().toISOString();

  const rows = await db
    .select(rotationColumns)
    .from(creditAccounts)
    .where(
      and(
        afterAccountId ? gt(creditAccounts.accountId, afterAccountId) : undefined,
        eq(creditAccounts.tier, 'free'),
        or(isNull(creditAccounts.nextCreditGrant), lte(creditAccounts.nextCreditGrant, now)),
      ),
    )
    .orderBy(asc(creditAccounts.accountId))
    .limit(ROTATION_BATCH_SIZE);

  return rows;
}
