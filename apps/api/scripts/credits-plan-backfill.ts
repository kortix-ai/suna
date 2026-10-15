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
 *                    subscription, and a row without the column falls back to
 *                    its legacy price (`planMonthlyUsd` in tiers.ts). It fills
 *                    the plan page amount and lets the legacy fallback go.
 *   --rewrite-tiers  (with --apply) also rewrites the stored tier: a live paid
 *                    subscription → `credits`, a dead one → `free`. For a live
 *                    row this is cosmetic: every legacy key already reads as
 *                    `credits` (`canonicalTier`), and compute is metered for
 *                    every plan from the deploy on. A dead row keeps reading as
 *                    paid until it is rewritten, as it does on dev today.
 *
 * A second pass ADOPTS paying subscriptions the account rows lost track of.
 * It lists every live, paying Stripe subscription (about 25 minutes: the
 * Stripe account also holds every Free account's $0 subscription) and, for
 * each one whose account row does not point at it:
 *   - adopt      the row has no other live paid subscription → with --apply,
 *                point the row at this one and put it on Credits at its amount.
 *                A 2026-10-15 prod audit found paying customers left on Free.
 *   - duplicate  the row already pays through another live subscription →
 *                listed for an operator (refund or cancel one), never changed.
 *   - orphan     no account row at all → counted and listed for an operator.
 *
 * Every write goes through `applyStripeSync`: an admin-pinned (enterprise) tier
 * is never touched, and the billing cache is invalidated.
 */
import { billingCustomers, creditAccounts } from '@kortix/db';
import type Stripe from 'stripe';
import { inArray, or, eq } from 'drizzle-orm';
import { db } from '../src/shared/db';
import { getStripe } from '../src/shared/stripe';
import { applyStripeSync } from '../src/billing/services/account-write-owner';
import { isDeadSubscriptionStatus } from '../src/billing/services/billing-state';
import {
  billingPeriodForSubscription,
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
  await adoptPayingSubscriptions();
  process.exit(0);
}

/** List-price USD per month of a subscription, discounts ignored (the allowance rule). */
function listMonthlyUsd(sub: Stripe.Subscription): number {
  return sub.items.data.reduce((total, item) => {
    const cents = (item.price?.unit_amount ?? 0) * (item.quantity ?? 1);
    return total + cents / 100 / (item.price?.recurring?.interval === 'year' ? 12 : 1);
  }, 0);
}

async function adoptPayingSubscriptions() {
  const stripe = getStripe();
  const customerAccount = new Map(
    (await db.select({ id: billingCustomers.id, accountId: billingCustomers.accountId }).from(billingCustomers)).map(
      (c) => [c.id, c.accountId],
    ),
  );
  const totals = { adopt: 0, adoptUsd: 0, duplicate: 0, orphan: 0, orphanUsd: 0 };
  for (const status of ['active', 'past_due', 'trialing'] as const) {
    for await (const sub of stripe.subscriptions.list({ status, limit: 100 })) {
      if (sub.metadata?.contract_id) continue;
      const usd = listMonthlyUsd(sub);
      if (usd <= 0 || planForSubscription(sub) !== 'credits') continue;
      const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      const accountId = sub.metadata?.account_id || customerAccount.get(customer) || null;
      const [row] = accountId
        ? await db.select(projection).from(creditAccounts).where(eq(creditAccounts.accountId, accountId)).limit(1)
        : [];
      if (!row) {
        totals.orphan++;
        totals.orphanUsd += usd;
        console.log(['orphan', sub.id, accountId ?? '-', usd.toFixed(2), sub.status].join('\t'));
        continue;
      }
      if (row.stripeSubscriptionId === sub.id) continue;
      const stored = row.stripeSubscriptionId
        ? await stripe.subscriptions.retrieve(row.stripeSubscriptionId).catch(() => null)
        : null;
      if (stored && !isDeadSubscriptionStatus(stored.status) && listMonthlyUsd(stored) > 0) {
        totals.duplicate++;
        console.log(['duplicate', sub.id, row.accountId, usd.toFixed(2), `also pays ${stored.id}`].join('\t'));
        continue;
      }
      const monthlyUsd = paidMonthlyUsd(sub, { tier: row.tier, seatCount: row.seatCount });
      totals.adopt++;
      totals.adoptUsd += monthlyUsd;
      console.log(['adopt', sub.id, row.accountId, monthlyUsd.toFixed(2), `row was ${row.tier ?? 'none'}`].join('\t'));
      if (!apply) continue;
      await applyStripeSync(
        row.accountId,
        {
          stripeSubscriptionId: sub.id,
          stripeSubscriptionStatus: sub.status,
          provider: 'stripe',
          tier: 'credits',
          planMonthlyUsd: String(monthlyUsd),
          planType: billingPeriodForSubscription(sub),
        },
        { account: row, mode: 'update', reason: 'credits-only-backfill:adopt' },
      );
    }
  }
  console.log(
    `\n${apply ? 'APPLIED' : 'DRY RUN'} adoption: ${totals.adopt} adopted (Σ ${totals.adoptUsd.toFixed(2)} USD/month) · ` +
      `${totals.duplicate} duplicates for an operator · ${totals.orphan} orphans for an operator (Σ ${totals.orphanUsd.toFixed(2)} USD/month)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
