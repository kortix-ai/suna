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
import { getCustomerByAccountId } from '../repositories/customers';
import { countActiveMembers } from './seat-management';
import { grantCredits } from './credits';
import { resolvePerSeatPriceId, defaultAutoTopupForSeats, MAX_SEATS_PER_ACCOUNT } from './tiers';

const ADVISORY_LOCK_NS = 'lazy_migrate';

function lockKey(accountId: string): bigint {
  // Hash accountId UUID into a stable 63-bit key for pg_advisory_lock.
  let h = 14695981039346656037n;
  for (const ch of `${ADVISORY_LOCK_NS}:${accountId}`) {
    h ^= BigInt(ch.charCodeAt(0));
    h = (h * 1099511628211n) & 0x7fffffffffffffffn;
  }
  return h;
}

interface MigrationResult {
  status: 'migrated' | 'skipped:already_per_seat' | 'skipped:yearly_commitment' | 'skipped:no_subs' | 'failed';
  proratedCreditUsd: number;
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

  return await withAdvisoryLock(accountId, async () => {
    // Re-read inside the lock — another worker may have raced ahead.
    const fresh = await getCreditAccount(accountId);
    if (!fresh || fresh.billingModel === 'per_seat') {
      return defaultResult('skipped:already_per_seat');
    }

    const customer = await getCustomerByAccountId(accountId);
    const stripe = getStripe();
    const now = Math.floor(Date.now() / 1000);

    // 1. Inventory active Stripe subs (may be none if the user is on free tier)
    const activeSubs: Stripe.Subscription[] = customer
      ? (await stripe.subscriptions.list({ customer: customer.id, status: 'active', limit: 100 })).data
      : [];

    if (activeSubs.length === 0) {
      // No paid history — just flip the flag, they'll subscribe via the new
      // per-seat checkout flow whenever they want to.
      await updateCreditAccount(accountId, { billingModel: 'per_seat' } as any);
      return defaultResult('skipped:no_subs');
    }

    // 2. Compute prorated remaining-period value for every active sub
    let totalProratedUsd = 0;
    const cancelledSubIds: string[] = [];
    for (const sub of activeSubs) {
      const remainingUsd = computeProratedRemaining(sub, now);
      totalProratedUsd += remainingUsd;
      try {
        await stripe.subscriptions.cancel(sub.id, { prorate: false } as any);
        cancelledSubIds.push(sub.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[lazy-migrate] failed to cancel sub ${sub.id} for ${accountId}: ${msg}`);
        return defaultResult('failed', `cancel ${sub.id}: ${msg}`);
      }
    }

    // 3. Create the per-seat sub (quantity = active member count, capped)
    const seatCount = Math.min(MAX_SEATS_PER_ACCOUNT, Math.max(1, await countActiveMembers(accountId)));
    const priceId = resolvePerSeatPriceId();
    let newSubscription: Stripe.Subscription | null = null;
    if (priceId && customer) {
      try {
        newSubscription = await stripe.subscriptions.create({
          customer: customer.id,
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
        console.error(`[lazy-migrate] failed to create per-seat sub for ${accountId}: ${msg}`);
        return defaultResult('failed', `create per-seat sub: ${msg}`);
      }
    }

    // 4. Grant the prorated credit (non-expiring) — credit_ledger is the audit log
    if (totalProratedUsd > 0) {
      const description = `Legacy migration credit (cancelled ${cancelledSubIds.length} subscription${cancelledSubIds.length === 1 ? '' : 's'})`;
      await grantCredits(accountId, totalProratedUsd, 'legacy_migration', description, false);
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
      proratedCreditUsd: round2(totalProratedUsd),
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
    cancelledSubIds: [],
    newSubscriptionId: null,
    stoppedSandboxIds: [],
    ...(reason ? { reason } : {}),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
