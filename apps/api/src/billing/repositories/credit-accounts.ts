import { creditAccounts } from '@kortix/db';
import { and, eq, isNull, lte, ne, or } from 'drizzle-orm';
import { db } from '../../shared/db';

export async function getCreditAccount(accountId: string) {
  const [row] = await db
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.accountId, accountId))
    .limit(1);

  return row ?? null;
}

/** Whether the account has the self-serve enterprise demo toggled on. */
export async function isDemoEnterprise(accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ demoEnterprise: creditAccounts.demoEnterprise })
    .from(creditAccounts)
    .where(eq(creditAccounts.accountId, accountId))
    .limit(1);
  return row?.demoEnterprise ?? false;
}

/** Whether the account is flagged as a contracted cloud Enterprise customer.
 *  When true the account resolves all enterprise entitlements (SSO/SCIM/RBAC/
 *  audit) regardless of its billing tier — decoupling feature entitlements
 *  from the commercial billing model. Set by an operator when a contract is
 *  signed. Distinct from the self-serve demo flag (`isDemoEnterprise`). */
export async function isEnterpriseEntitled(accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ enterpriseEntitled: creditAccounts.enterpriseEntitled })
    .from(creditAccounts)
    .where(eq(creditAccounts.accountId, accountId))
    .limit(1);
  return row?.enterpriseEntitled ?? false;
}

// NOTE — there are deliberately no `setEnterpriseEntitled` /
// `setManagedModelsOverride` / `setDemoEnterprise` writers here any more.
// Those three columns are ADMIN-OWNED (billing/services/account-write-owner.ts):
// every write goes through `applyAdminOverride`, which enforces the ownership
// boundary against provider sync and invalidates the billing cache. A private
// per-column setter is exactly the bypass that boundary exists to prevent.
// The readers above stay — reading is not a write.

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
      trialStartedAt: creditAccounts.trialStartedAt,
      trialTier: creditAccounts.trialTier,
      trialSeats: creditAccounts.trialSeats,
      managedModelsOverride: creditAccounts.managedModelsOverride,
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
      // Operator-set per-account concurrent-session override (NULL = use tier).
      maxConcurrentSessions: creditAccounts.maxConcurrentSessions,
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
        or(isNull(creditAccounts.nextCreditGrant), lte(creditAccounts.nextCreditGrant, now)),
      ),
    );

  return rows;
}

export async function getFreeAccountsDueForRotation() {
  const now = new Date().toISOString();

  const rows = await db
    .select()
    .from(creditAccounts)
    .where(
      and(
        eq(creditAccounts.tier, 'free'),
        or(isNull(creditAccounts.nextCreditGrant), lte(creditAccounts.nextCreditGrant, now)),
      ),
    );

  return rows;
}
