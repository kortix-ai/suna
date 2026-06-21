import { eq, and, or, isNull, lte, ne } from 'drizzle-orm';
import { creditAccounts } from '@kortix/db';
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

export async function getYearlyAccountsDueForRotation() {
  const now = new Date().toISOString();

  const rows = await db
    .select()
    .from(creditAccounts)
    .where(
      and(
        eq(creditAccounts.planType, 'yearly'),
        ne(creditAccounts.tier, 'free'),
        eq(creditAccounts.stripeSubscriptionStatus, 'active'),
        ne(creditAccounts.paymentStatus, 'past_due'),
        or(
          isNull(creditAccounts.nextCreditGrant),
          lte(creditAccounts.nextCreditGrant, now),
        ),
      ),
    );

  return rows;
}
