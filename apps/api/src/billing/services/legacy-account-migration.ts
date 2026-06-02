/**
 * Lazy auto-migration: legacy customer → per-seat on first sign-in.
 *
 * Triggered fire-and-forget from /v1/billing/account-state. Sign-in itself
 * is never blocked by Stripe latency. The next account-state refetch picks
 * up the new billing_model.
 *
 * What it does for a `billing_model='legacy'` account with active subs:
 *   1. Sum prorated remaining-period value across all active Stripe subs
 *   2. Cancel each sub in Stripe (prorate:false — we control the math)
 *   3. Create one per-seat sub at quantity=member_count
 *   4. Grant the prorated total as non-expiring wallet credit
 *   5. Flip credit_accounts.billing_model='per_seat'
 *   6. Stop sandboxes beyond member_count (keep top-N by last_used_at)
 *
 * Refuse conditions:
 *   - billing_model already 'per_seat' → no-op
 *   - commitmentType='yearly_commitment' and commitment still active → no-op
 *   - No Stripe customer at all (free tier user) → just flip the flag, no Stripe work
 *
 * Concurrency: postgres advisory lock keyed by account_id. Concurrent sign-ins
 * from multiple devices serialize through the lock; the second sees billing_model
 * already 'per_seat' and exits.
 */

import { eq, desc, and, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { sandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { getStripe } from '../../shared/stripe';
import { getCreditAccount, updateCreditAccount } from '../repositories/credit-accounts';
import { resolveLiveStripeCustomerId } from './subscriptions';
import { countActiveMembers } from './seat-management';
import { grantCredits } from './credits';
import { resolvePerSeatPriceId, defaultAutoTopupForSeats, MAX_SEATS_PER_ACCOUNT, PER_SEAT_PRICE_USD } from './tiers';

const ADVISORY_LOCK_NS = 'lazy_migrate';

function lockKey(accountId: string): bigint {
  let h = 14695981039346656037n;
  for (const ch of `${ADVISORY_LOCK_NS}:${accountId}`) {
    h ^= BigInt(ch.charCodeAt(0));
    h = (h * 1099511628211n) & 0x7fffffffffffffffn;
  }
  return h;
}

interface MigrationResult {
  status: 'migrated' | 'skipped:already_per_seat' | 'skipped:yearly_commitment' | 'skipped:no_subs' | 'skipped:no_legacy_machine' | 'failed';
  proratedCreditUsd: number;
  firstSeatCoveredUsd: number;
  cancelledSubIds: string[];
  newSubscriptionId: string | null;
  stoppedSandboxIds: string[];
  reason?: string;
}

export async function maybeMigrateLegacyAccount(accountId: string): Promise<MigrationResult> {
  const account = await getCreditAccount(accountId);
  if (!account) {
    return defaultResult('skipped:no_subs', 'No credit account');
  }
  if (account.billingModel === 'per_seat') {
    return defaultResult('skipped:already_per_seat');
  }
  if (account.commitmentType === 'yearly_commitment' && account.commitmentEndDate) {
    const ends = new Date(account.commitmentEndDate);
    if (ends > new Date()) {
      return defaultResult('skipped:yearly_commitment', `Commitment active until ${ends.toISOString()}`);
    }
  }

  if (!(await accountHasLegacyMachine(accountId))) {
    return defaultResult('skipped:no_legacy_machine');
  }

  return await withAdvisoryLock(accountId, async () => {
    const fresh = await getCreditAccount(accountId);
    if (!fresh || fresh.billingModel === 'per_seat') {
      return defaultResult('skipped:already_per_seat');
    }

    const customerId = await resolveLiveStripeCustomerId(accountId);
    const stripe = getStripe();
    const now = Math.floor(Date.now() / 1000);

    const activeSubs: Stripe.Subscription[] = customerId
      ? (await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 100 })).data
      : [];

    if (activeSubs.length === 0) {
      await updateCreditAccount(accountId, { billingModel: 'per_seat' } as any);
      return defaultResult('skipped:no_subs');
    }

    const seatCount = Math.min(MAX_SEATS_PER_ACCOUNT, Math.max(1, await countActiveMembers(accountId)));
    const priceId = resolvePerSeatPriceId();
    if (!priceId) {
      console.error(`[lazy-migrate] refusing migration for ${accountId}: per-seat price not configured`);
      return defaultResult('failed', 'per-seat price not configured');
    }
    if (!customerId) {
      console.error(`[lazy-migrate] refusing migration for ${accountId}: no Stripe customer record`);
      return defaultResult('failed', 'no Stripe customer for account with active subs');
    }

    // The unused (prorated) value of the legacy machine subs is returned IN FULL,
    // split so the move costs nothing out of pocket now:
    //   • the FIRST seat period is pre-paid from it (a Stripe customer-balance
    //     credit that offsets the first per-seat invoice), and
    //   • the leftover is granted as non-expiring wallet credit.
    // e.g. $100 remaining, 1 seat → $20 covers the first seat month + $80 credit.
    const totalProratedUsd = round2(
      activeSubs.reduce((sum, sub) => sum + computeProratedRemaining(sub, now), 0),
    );
    const seatCostUsd = PER_SEAT_PRICE_USD * seatCount;
    const firstSeatCoveredUsd = round2(Math.min(seatCostUsd, totalProratedUsd));
    const walletCreditUsd = round2(totalProratedUsd - firstSeatCoveredUsd);

    // Apply the first-seat offset as a customer-balance credit BEFORE creating the
    // sub so the first invoice picks it up (often → $0, so no payment method is
    // even required). Non-fatal: if it errors, the seat just bills normally.
    if (firstSeatCoveredUsd > 0) {
      try {
        await stripe.customers.createBalanceTransaction(customerId, {
          amount: -Math.round(firstSeatCoveredUsd * 100), // negative = credit to the customer
          currency: 'usd',
          description: 'Legacy machine credit applied to first seat period',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[lazy-migrate] failed to apply first-seat balance credit for ${accountId}: ${msg}`);
      }
    }

    // 2. Create the per-seat sub — BEFORE cancelling anything. Critical safety
    //    property: if the charge can't be set up we abort with the customer's
    //    legacy subs intact, never leaving them with no subscription. The first
    //    invoice is offset by the balance credit above.
    let newSubscription: Stripe.Subscription;
    try {
      newSubscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId, quantity: seatCount }],
        collection_method: 'charge_automatically',
        metadata: {
          account_id: accountId,
          billing_model: 'per_seat',
          initial_seat_count: String(seatCount),
          source: 'lazy_migration',
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[lazy-migrate] failed to create per-seat sub for ${accountId} (legacy subs left untouched): ${msg}`);
      return defaultResult('failed', `create per-seat sub: ${msg}`);
    }

    // 3. The seat sub is now active — cancel the legacy subs (prorate:false; we've
    //    already computed + returned their remainder). A cancel failure here is
    //    non-fatal: the replacement is already in place, so we log for cleanup.
    const cancelledSubIds: string[] = [];
    for (const sub of activeSubs) {
      try {
        await stripe.subscriptions.cancel(sub.id, { prorate: false } as any);
        cancelledSubIds.push(sub.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[lazy-migrate] failed to cancel legacy sub ${sub.id} for ${accountId} (seat sub ${newSubscription.id} is active; legacy sub left for manual cleanup): ${msg}`);
      }
    }

    // 4. Grant the leftover as non-expiring wallet credit. Refuse to flip
    //    billing_model if the grant fails, otherwise the credit is lost silently.
    if (walletCreditUsd > 0) {
      const description = `Legacy migration credit (cancelled ${cancelledSubIds.length} subscription${cancelledSubIds.length === 1 ? '' : 's'}; first seat period pre-paid)`;
      try {
        const granted = await grantCredits(accountId, walletCreditUsd, 'legacy_migration', description, false);
        if (granted && typeof granted === 'object' && 'success' in granted && (granted as any).success === false) {
          console.error(`[lazy-migrate] grantCredits returned success=false for ${accountId}: ${JSON.stringify(granted)}`);
          return defaultResult('failed', 'credit grant returned success=false');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[lazy-migrate] grantCredits threw for ${accountId}: ${msg}`);
        return defaultResult('failed', `credit grant: ${msg}`);
      }
    }

    // 5. Flip billing_model + record new subscription
    const seatItem = newSubscription?.items.data[0];
    const defaults = defaultAutoTopupForSeats(seatCount);
    await updateCreditAccount(accountId, {
      billingModel: 'per_seat',
      seatCount,
      seatSubscriptionItemId: seatItem?.id ?? null,
      stripeSubscriptionId: newSubscription?.id ?? null,
      stripeSubscriptionStatus: newSubscription?.status ?? null,
      autoTopupEnabled: true,
      autoTopupThreshold: String(fresh.autoTopupCustomized ? fresh.autoTopupThreshold : defaults.threshold),
      autoTopupAmount: String(fresh.autoTopupCustomized ? fresh.autoTopupAmount : defaults.amount),
    } as any);

    // 6. Stop sandboxes beyond the seat count (keep top N by last_used_at)
    const stoppedSandboxIds = await stopSurplusSandboxes(accountId, seatCount, cancelledSubIds);

    return {
      status: 'migrated',
      proratedCreditUsd: walletCreditUsd,
      firstSeatCoveredUsd,
      cancelledSubIds,
      newSubscriptionId: newSubscription?.id ?? null,
      stoppedSandboxIds,
    };
  });
}

function computeProratedRemaining(sub: Stripe.Subscription, nowSeconds: number): number {
  const start = sub.current_period_start;
  const end = sub.current_period_end;
  if (!start || !end || end <= nowSeconds) return 0;
  const totalSeconds = end - start;
  const remainingSeconds = end - nowSeconds;
  if (totalSeconds <= 0) return 0;
  const item = sub.items.data[0];
  const unitAmount = item?.price?.unit_amount ?? 0;
  const quantity = item?.quantity ?? 1;
  const periodUsd = (unitAmount * quantity) / 100;
  return round2(periodUsd * (remainingSeconds / totalSeconds));
}

async function accountHasLegacyMachine(accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: sandboxes.sandboxId })
    .from(sandboxes)
    .where(eq(sandboxes.accountId, accountId))
    .limit(1);
  return Boolean(row);
}

async function stopSurplusSandboxes(
  accountId: string,
  seatCount: number,
  cancelledSubIds: string[],
): Promise<string[]> {
  const active = await db
    .select({ sandboxId: sandboxes.sandboxId, metadata: sandboxes.metadata })
    .from(sandboxes)
    .where(and(eq(sandboxes.accountId, accountId), eq(sandboxes.status, 'active')))
    .orderBy(desc(sandboxes.lastUsedAt));
  const surplus = active.slice(seatCount);
  if (surplus.length === 0) return [];
  const surplusIds = surplus.map((s) => s.sandboxId);

  const stoppedReason = {
    stopped_reason: 'legacy_migration',
    stopped_at: new Date().toISOString(),
    cancelled_subscriptions: cancelledSubIds,
  };
  await db
    .update(sandboxes)
    .set({
      status: 'stopped',
      metadata: sql`COALESCE(${sandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify(stoppedReason)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(sandboxes.accountId, accountId), sql`sandbox_id = ANY(${surplusIds}::uuid[])`));
  return surplusIds;
}

async function withAdvisoryLock<T>(
  accountId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = lockKey(accountId);
  await db.execute(sql`SELECT pg_advisory_lock(${key})`);
  try {
    return await fn();
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${key})`).catch(() => {});
  }
}

function defaultResult(
  status: MigrationResult['status'],
  reason?: string,
): MigrationResult {
  return {
    status,
    proratedCreditUsd: 0,
    firstSeatCoveredUsd: 0,
    cancelledSubIds: [],
    newSubscriptionId: null,
    stoppedSandboxIds: [],
    ...(reason ? { reason } : {}),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
