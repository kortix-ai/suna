/**
 * Operator backfill for credits-only billing (2026-10-14).
 *
 *   dotenvx run -f apps/api/.env.prod -- bun run apps/api/scripts/credits-plan-backfill.ts            # dry run
 *   dotenvx run -f apps/api/.env.prod -- bun run apps/api/scripts/credits-plan-backfill.ts --apply    # write plan_monthly_usd
 *   dotenvx run -f apps/api/.env.prod -- bun run apps/api/scripts/credits-plan-backfill.ts --apply --rewrite-tiers
 *
 * Reads every account whose STORED tier is a legacy paid key (or `credits`),
 * asks the provider what it bills, and prints one line per account.
 *
 *   --apply          writes `plan_monthly_usd` from the live subscription. No
 *                    customer-visible effect: renewals already read the
 *                    subscription; this only fills the plan page amount.
 *   --rewrite-tiers  (with --apply) also rewrites the stored tier: a live paid
 *                    subscription → `credits`, a dead one → `free`. This ENDS the
 *                    compute-metering exemption of legacy flat plans
 *                    (LEGACY_PAID_TIERS_UNMETERED reads the raw stored tier), so
 *                    run it only after the customer notice.
 *
 * Every write goes through `applyStripeSync`: an admin-pinned (enterprise) tier
 * is never touched, and the billing cache is invalidated.
 */
import { creditAccounts } from '@kortix/db';
import { inArray, or, eq } from 'drizzle-orm';
import { db } from '../src/shared/db';
import { getStripe } from '../src/shared/stripe';
import { applyStripeSync } from '../src/billing/services/account-write-owner';
import { isDeadSubscriptionStatus } from '../src/billing/services/billing-state';
import {
  LEGACY_PAID_PLAN_KEYS,
  monthlyCreditsForSubscription,
  paidMonthlyUsd,
  planForSubscription,
  revenueCatProductMonthlyUsd,
} from '../src/billing/services/tiers';

const apply = process.argv.includes('--apply');
const rewriteTiers = process.argv.includes('--rewrite-tiers');
for (const a of process.argv.slice(2)) {
  if (a !== '--apply' && a !== '--rewrite-tiers') throw new Error(`unknown arg ${a}`);
}
if (rewriteTiers && !apply) throw new Error('--rewrite-tiers needs --apply');

type Action = { monthlyUsd: number | null; tier: 'credits' | 'free' | null; note: string };

// Only the columns this script reads, so a dry run works before the
// plan_monthly_usd migration has reached the target database.
const projection = {
  accountId: creditAccounts.accountId,
  tier: creditAccounts.tier,
  provider: creditAccounts.provider,
  stripeSubscriptionId: creditAccounts.stripeSubscriptionId,
  seatCount: creditAccounts.seatCount,
  revenuecatProductId: creditAccounts.revenuecatProductId,
  revenuecatCancelledAt: creditAccounts.revenuecatCancelledAt,
  paymentStatus: creditAccounts.paymentStatus,
  enterpriseEntitled: creditAccounts.enterpriseEntitled,
};
type Row = { [K in keyof typeof projection]: (typeof creditAccounts.$inferSelect)[K] };

async function decide(row: Row): Promise<Action> {
  if (row.provider === 'revenuecat') {
    const usd = revenueCatProductMonthlyUsd(row.revenuecatProductId ?? '');
    if (usd === null) return { monthlyUsd: null, tier: null, note: `unknown store product ${row.revenuecatProductId ?? '-'}` };
    return row.revenuecatCancelledAt && row.paymentStatus === 'failed'
      ? { monthlyUsd: null, tier: 'free', note: 'store subscription expired' }
      : { monthlyUsd: usd, tier: 'credits', note: `store product ${row.revenuecatProductId}` };
  }
  if (!row.stripeSubscriptionId) return { monthlyUsd: null, tier: 'free', note: 'paid tier, no subscription' };
  const sub = await getStripe().subscriptions.retrieve(row.stripeSubscriptionId).catch(() => null);
  if (!sub) return { monthlyUsd: null, tier: 'free', note: 'subscription not found in Stripe' };
  if (isDeadSubscriptionStatus(sub.status)) return { monthlyUsd: null, tier: 'free', note: `subscription ${sub.status}` };
  const plan = planForSubscription(sub);
  if (plan === 'free') return { monthlyUsd: null, tier: 'free', note: 'on the free price' };
  // A paid stored tier on a $0 / unmapped price is a comp: it keeps its amount.
  const usd = paidMonthlyUsd(sub, { tier: row.tier, seatCount: row.seatCount });
  const comped = monthlyCreditsForSubscription(sub) === 0;
  return { monthlyUsd: usd, tier: 'credits', note: `subscription ${sub.status}${comped ? ` (comped, $0 price ${sub.items.data[0]?.price?.id ?? '-'})` : ''}` };
}

async function main() {
  const rows: Row[] = await db
    .select(projection)
    .from(creditAccounts)
    .where(or(inArray(creditAccounts.tier, [...LEGACY_PAID_PLAN_KEYS, 'credits']), eq(creditAccounts.provider, 'revenuecat')));

  const totals = { rows: rows.length, amount: 0, toCredits: 0, toFree: 0, skipped: 0, monthlyUsd: 0 };
  for (const row of rows) {
    const action = await decide(row);
    const tierChange = rewriteTiers && action.tier && action.tier !== row.tier ? action.tier : null;
    console.log(
      [row.accountId, row.tier, row.provider ?? '-', action.monthlyUsd ?? '-', action.tier ?? 'keep', action.note].join('\t'),
    );
    if (action.monthlyUsd !== null) {
      totals.amount++;
      totals.monthlyUsd += action.monthlyUsd;
    }
    if (action.tier === 'credits') totals.toCredits++;
    else if (action.tier === 'free') totals.toFree++;
    else totals.skipped++;
    if (!apply) continue;
    if (action.monthlyUsd === null && !tierChange) continue;
    await applyStripeSync(
      row.accountId,
      {
        ...(action.monthlyUsd !== null ? { planMonthlyUsd: String(action.monthlyUsd) } : {}),
        ...(tierChange ? { tier: tierChange, ...(tierChange === 'free' ? { planMonthlyUsd: null } : {}) } : {}),
      },
      { account: row, mode: 'update', reason: 'credits-only-backfill' },
    );
  }
  console.log(
    `\n${apply ? 'APPLIED' : 'DRY RUN'}${rewriteTiers ? ' + tier rewrite' : ''}: ${totals.rows} rows · ` +
      `${totals.amount} with an amount (Σ ${totals.monthlyUsd.toFixed(2)} USD/month) · ` +
      `${totals.toCredits} → credits · ${totals.toFree} → free · ${totals.skipped} left as is`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
