import { eq, and, or, isNull, lte, ne, sql } from 'drizzle-orm';
import { creditAccounts } from '@kortix/db';
import { db } from '../../shared/db';

/**
 * Read tier from the OLD public.credit_accounts (Suna billing schema).
 * Used ONLY for claim-computer eligibility in cloud env.
 */
export async function getPublicSchemaTier(accountId: string): Promise<string | null> {
  try {
    const result = await db.execute(
      sql`SELECT tier FROM public.credit_accounts WHERE account_id = ${accountId} LIMIT 1`,
    );
    const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
    return rows[0]?.tier ?? null;
  } catch {
    return null;
  }
}

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

export async function updateBalance(
  accountId: string,
  fields: {
    balance?: string;
    expiringCredits?: string;
    nonExpiringCredits?: string;
    dailyCreditsBalance?: string;
  },
) {
  await db
    .update(creditAccounts)
    .set({ ...fields, updatedAt: new Date().toISOString() })
    .where(eq(creditAccounts.accountId, accountId));
}
