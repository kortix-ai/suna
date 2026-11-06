/**
 * Billing of a workspace split off a legacy account (Workspaces, design.md
 * §3.2 C6, known item K4).
 *
 * A legacy account holds 2+ projects. The split moves each extra project into
 * its own new account (one workspace = one account). The new account's wallet
 * starts as Free with 0 credits and no free-credit eligibility
 * (`workspace-split-copy.ts`, inside the move's transaction). After the move
 * commits, the split runner calls `applySplitOffBilling` once per move:
 *
 * - Source on Free (or paying only through top-ups or a contract): the
 *   split-off goes on Free WITH free-credit eligibility and gets one Free
 *   monthly grant now (wallet key `split_off_grant:<runId>:<newAccountId>`). This is a one-time
 *   exception to "free credits once per person": the person did not choose to
 *   have a second workspace. No `free_credit_claims` row is written.
 * - Source on a paid plan: the split-off gets the keeper's plan comped, with
 *   no Stripe subscription, until min(the keeper's current period end,
 *   now + 31 days), stored in `credit_accounts.comp_plan_until`. It gets the
 *   plan's monthly credits pro-rated to the comp window, expiring at the comp
 *   end (wallet key `split_off_comp:<runId>:<newAccountId>`). At the comp end the billing
 *   rotation (`expireSplitOffComps`) moves it to Free with eligibility.
 *
 * The plan write goes through `applyAdminOverride` (the operator write path)
 * and every change records an audit event. Every function is idempotent per
 * `runId`: the wallet keys refuse a second grant, and the row writes set the
 * same values again.
 *
 * Units: `grantedCredits` and `credits` are credits (1 credit = $0.01), the
 * unit the product shows. The wallet stores USD.
 */
import { creditAccounts, creditPurchases } from '@kortix/db';
import { and, eq, isNotNull, lte } from 'drizzle-orm';

import { db } from '../../shared/db';
import { accountIsPaying } from '../../workspaces/surface';
import { getCreditAccount, updateCreditAccount } from '../repositories/credit-accounts';
import { wallet } from '../wallet';
import { applyAdminOverride } from './account-write-owner';
import { invalidateAccountBilling } from './billing-cache';
import { hasLiveSubscription, billingSnapshotFromAccount } from './billing-state';
import { calculateNextCreditGrant } from './credit-grant-schedule';
import { canonicalTier, getTier, planMonthlyUsd } from './tiers';
import { currentPeriodStart } from './usage-breakdown';

const DAY_MS = 86_400_000;
/** The longest comp window: one month, whatever the keeper's period says. */
const MAX_COMP_DAYS = 31;

export type SplitOffBilling =
  | { kind: 'free'; grantedCredits: number }
  | { kind: 'comped'; tier: string; planMonthlyUsd: number; compedUntil: string; grantedCredits: number };

export interface SplitOffBillingPreview {
  kind: 'free' | 'comped';
  compedUntil: string | null;
  credits: number;
}

/**
 * `kortix.account_is_paying(accountId)` (C6): a paid tier, purchased
 * credits, a completed credit purchase or an active Enterprise contract. A
 * `stripe_subscription_id` alone never counts.
 */
export async function isPayingAccount(accountId: string): Promise<boolean> {
  return accountIsPaying(accountId);
}

type CreditRow = NonNullable<Awaited<ReturnType<typeof getCreditAccount>>>;

/** The comp a paying source hands its split-off, or null when the source's plan is Free. */
interface CompPlan {
  tier: 'credits';
  planMonthlyUsd: number;
  compedUntil: Date;
  grantUsd: number;
}

function toCredits(usd: number): number {
  return Math.round(usd * 100);
}

/** End of the source's current billing period, or null when it has no anchor. */
function periodBounds(source: CreditRow, now: Date): { start: Date; end: Date } | null {
  const start = currentPeriodStart(source.billingCycleAnchor ?? null, now);
  if (!start) return null;
  // A period is at most 31 days, so 32 days past its start lands in the next one.
  const end = currentPeriodStart(source.billingCycleAnchor ?? null, new Date(new Date(start).getTime() + 32 * DAY_MS));
  if (!end) return null;
  return { start: new Date(start), end: new Date(end) };
}

/**
 * The comp for a split-off of `source`, or null when the source is on Free.
 * Pure: `now` is the clock.
 */
export function compPlanFor(source: CreditRow | null, paying: boolean, now: Date): CompPlan | null {
  if (!source || !paying) return null;
  if (canonicalTier(source.tier) !== 'credits') return null;
  const monthlyUsd = planMonthlyUsd(source);
  if (!(monthlyUsd > 0)) return null;

  const cap = new Date(now.getTime() + MAX_COMP_DAYS * DAY_MS);
  const bounds = periodBounds(source, now);
  const periodEnd = bounds && bounds.end > now ? bounds.end : cap;
  const compedUntil = periodEnd < cap ? periodEnd : cap;
  const periodDays = bounds ? Math.max(1, (bounds.end.getTime() - bounds.start.getTime()) / DAY_MS) : MAX_COMP_DAYS;
  const remainingDays = Math.max(0, (compedUntil.getTime() - now.getTime()) / DAY_MS);
  const ratio = Math.min(1, remainingDays / periodDays);
  // Whole cents: the wallet stores USD with cent precision on grants.
  const grantUsd = Math.floor(monthlyUsd * ratio * 100) / 100;
  return { tier: 'credits', planMonthlyUsd: monthlyUsd, compedUntil, grantUsd };
}

async function recordSplitOffAudit(accountId: string, action: string, after: Record<string, unknown>): Promise<void> {
  try {
    const { recordAuditEvent } = await import('../../shared/audit');
    await recordAuditEvent({
      accountId,
      actorUserId: null,
      action,
      resourceType: 'credit_account',
      resourceId: accountId,
      after,
    });
  } catch {
    /* audit is best-effort, as on every operator billing write */
  }
}

/** What `applySplitOffBilling` would do for a split-off of `sourceAccountId`, for the dry-run report. */
export async function previewSplitOffBilling(
  sourceAccountId: string,
  now: Date = new Date(),
): Promise<SplitOffBillingPreview> {
  const [source, paying] = await Promise.all([getCreditAccount(sourceAccountId), isPayingAccount(sourceAccountId)]);
  const comp = compPlanFor(source, paying, now);
  if (comp) return { kind: 'comped', compedUntil: comp.compedUntil.toISOString(), credits: toCredits(comp.grantUsd) };
  return { kind: 'free', compedUntil: null, credits: toCredits(getTier('free').monthlyCredits) };
}

/**
 * Set the split-off's billing after its move committed. Idempotent per
 * `runId`. The comp window is fixed by the first call: a replay keeps the
 * stored `comp_plan_until`.
 */
export async function applySplitOffBilling(
  input: { runId: string; sourceAccountId: string; newAccountId: string },
  now: Date = new Date(),
): Promise<SplitOffBilling> {
  const { runId, sourceAccountId, newAccountId } = input;
  const [source, paying, target] = await Promise.all([
    getCreditAccount(sourceAccountId),
    isPayingAccount(sourceAccountId),
    getCreditAccount(newAccountId),
  ]);
  const comp = compPlanFor(source, paying, now);

  if (!comp) {
    const freeUsd = getTier('free').monthlyCredits;
    const expiresAt = target?.nextCreditGrant ?? calculateNextCreditGrant(now).toISOString();
    await db
      .insert(creditAccounts)
      .values({
        accountId: newAccountId,
        tier: 'free',
        billingCycleAnchor: now.toISOString(),
        nextCreditGrant: expiresAt,
        freeCreditsEligible: true,
      })
      .onConflictDoUpdate({
        target: creditAccounts.accountId,
        set: { freeCreditsEligible: true, nextCreditGrant: expiresAt, updatedAt: now.toISOString() },
      });
    const granted = await wallet.grant({
      accountId: newAccountId,
      amount: freeUsd,
      kind: 'free_tier_grant',
      description: 'Free credits for a workspace split off a free account',
      expiring: true,
      expiresAt,
      key: { event: `split_off_grant:${runId}` },
    });
    invalidateAccountBilling(newAccountId);
    if (!granted.replayed) {
      await recordSplitOffAudit(newAccountId, 'billing.split_off.free', {
        run_id: runId,
        source_account_id: sourceAccountId,
        free_credits_eligible: true,
        granted_credits: toCredits(freeUsd),
      });
    }
    return { kind: 'free', grantedCredits: toCredits(freeUsd) };
  }

  // A replay keeps the window of the first call.
  const storedUntil = target?.compPlanUntil ? new Date(target.compPlanUntil) : null;
  const compedUntil = storedUntil && storedUntil > now ? storedUntil : comp.compedUntil;
  await applyAdminOverride(
    newAccountId,
    {
      tier: comp.tier,
      planMonthlyUsd: String(comp.planMonthlyUsd),
      compPlanUntil: compedUntil.toISOString(),
      freeCreditsEligible: false,
      nextCreditGrant: null,
    },
    { userId: null, action: 'billing.split_off.comp' },
  );
  const granted = await wallet.grant({
    accountId: newAccountId,
    amount: comp.grantUsd,
    kind: 'tier_grant',
    description: 'Plan credits for a workspace split off a paid account, until the comp ends',
    expiring: true,
    expiresAt: compedUntil.toISOString(),
    key: { event: `split_off_comp:${runId}` },
  });
  if (!granted.replayed) {
    await recordSplitOffAudit(newAccountId, 'billing.split_off.comp', {
      run_id: runId,
      source_account_id: sourceAccountId,
      tier: comp.tier,
      plan_monthly_usd: comp.planMonthlyUsd,
      comp_plan_until: compedUntil.toISOString(),
      granted_credits: toCredits(comp.grantUsd),
    });
  }
  return {
    kind: 'comped',
    tier: comp.tier,
    planMonthlyUsd: comp.planMonthlyUsd,
    compedUntil: compedUntil.toISOString(),
    grantedCredits: toCredits(comp.grantUsd),
  };
}

/**
 * A live paid subscription with any provider: a Stripe subscription in a live
 * status, or a RevenueCat (App Store / Google Play) subscription whose plan is
 * still on. The RevenueCat EXPIRATION webhook moves the tier to Free, so a
 * paid tier with a subscription id is a plan the person still pays for.
 */
export function hasLivePaidSubscription(row: CreditRow, now: Date = new Date()): boolean {
  if (hasLiveSubscription(billingSnapshotFromAccount(row))) return true;
  if (row.provider !== 'revenuecat' || !row.revenuecatSubscriptionId) return false;
  if (['free', 'none'].includes(row.tier ?? 'free')) return false;
  return row.revenuecatCancelAtPeriodEnd == null || new Date(row.revenuecatCancelAtPeriodEnd) > now;
}

/** The split-off took money: a top-up, a completed purchase or a live subscription (any provider). */
async function tookMoney(accountId: string, row: CreditRow | null): Promise<boolean> {
  if (row && Number(row.lifetimePurchased ?? 0) > 0) return true;
  if (row && hasLivePaidSubscription(row)) return true;
  const [purchase] = await db
    .select({ id: creditPurchases.id })
    .from(creditPurchases)
    .where(and(eq(creditPurchases.accountId, accountId), eq(creditPurchases.status, 'completed')))
    .limit(1);
  return Boolean(purchase);
}

export class SplitOffBillingTookMoneyError extends Error {
  readonly name = 'SplitOffBillingTookMoneyError';
  constructor(readonly accountId: string) {
    super(`The split-off workspace ${accountId} took money; its billing cannot be reversed`);
  }
}

/**
 * Undo `applySplitOffBilling` when the split reverses: clear the comp, put the
 * account back on Free with no eligibility, and forfeit its unspent credits
 * (they were the split-off grant). Throws `SplitOffBillingTookMoneyError` when
 * the account took money; the split's reverse refuses that case first.
 * Idempotent.
 */
export async function reverseSplitOffBilling(input: { runId: string; newAccountId: string }): Promise<void> {
  const { runId, newAccountId } = input;
  const row = await getCreditAccount(newAccountId);
  if (!row) return;
  if (await tookMoney(newAccountId, row)) throw new SplitOffBillingTookMoneyError(newAccountId);

  const wasComped = row.compPlanUntil != null;
  if (wasComped || row.tier !== 'free') {
    await applyAdminOverride(
      newAccountId,
      { tier: 'free', planMonthlyUsd: null, compPlanUntil: null },
      { userId: null, action: 'billing.split_off.reverse' },
    );
  }
  await updateCreditAccount(newAccountId, { freeCreditsEligible: false, nextCreditGrant: null });
  const before = Number(row.balance ?? 0);
  await wallet.forfeit(newAccountId);
  invalidateAccountBilling(newAccountId);
  await recordSplitOffAudit(newAccountId, 'billing.split_off.reverse', {
    run_id: runId,
    comp_cleared: wasComped,
    forfeited_credits: toCredits(Math.max(0, before)),
  });
}

/**
 * The billing rotation's comp step: every split-off whose comp ended moves to
 * Free with free-credit eligibility and gets its first Free grant now. A
 * split-off that started its own paid subscription during the comp keeps that
 * plan; only the comp marker is cleared. Returns the accounts it moved.
 */
export async function expireSplitOffComps(now: Date = new Date()): Promise<{ ended: string[]; kept: string[] }> {
  const due = await db
    .select()
    .from(creditAccounts)
    .where(and(isNotNull(creditAccounts.compPlanUntil), lte(creditAccounts.compPlanUntil, now.toISOString())))
    .limit(500);
  const ended: string[] = [];
  const kept: string[] = [];
  for (const row of due) {
    const until = row.compPlanUntil!;
    if (hasLivePaidSubscription(row, now)) {
      await applyAdminOverride(row.accountId, { compPlanUntil: null }, { userId: null, action: 'billing.split_off.comp_ended' });
      kept.push(row.accountId);
      continue;
    }
    const nextGrant = calculateNextCreditGrant(now).toISOString();
    await applyAdminOverride(
      row.accountId,
      { tier: 'free', planMonthlyUsd: null, compPlanUntil: null, freeCreditsEligible: true, nextCreditGrant: nextGrant, lastGrantDate: now.toISOString() },
      { userId: null, action: 'billing.split_off.comp_ended' },
    );
    // Replaces the expiring bucket: the comp's plan credits end with the comp.
    const freeUsd = getTier('free').monthlyCredits;
    await wallet.reset({
      accountId: row.accountId,
      amount: freeUsd,
      expiresAt: nextGrant,
      description: 'Free credits after the split-off comp ended',
      key: { event: `split_off_comp_end:${row.accountId}:${new Date(until).toISOString()}` },
    });
    await recordSplitOffAudit(row.accountId, 'billing.split_off.comp_ended', {
      comp_plan_until: new Date(until).toISOString(),
      tier: 'free',
      free_credits_eligible: true,
      granted_credits: toCredits(freeUsd),
    });
    ended.push(row.accountId);
  }
  return { ended, kept };
}
