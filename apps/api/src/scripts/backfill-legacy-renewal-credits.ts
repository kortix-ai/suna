#!/usr/bin/env bun
/**
 * One-off backfill: pay back the renewal credits that zero-grant legacy tiers
 * never granted.
 *
 * Background. `handleInvoicePaid`'s renewal branch sized its grant with
 * `getMonthlyCredits(tier)`, which is 0 for legacy `pro` (and any other paid
 * tier the catalog gives no monthly grant). Those customers paid every month
 * and received nothing, sat at a $0 wallet, and — because the wallet floor
 * additionally required a per-seat billing model — could not start a single
 * run. PR #6662 fixed both halves going forward: a paid renewal now grants
 * `amount_paid × INCLUDED_CREDITS_RATIO`. This script settles the past.
 *
 * WHAT IT PAYS. For every affected account, each Stripe invoice that is
 * `status=paid`, `billing_reason=subscription_cycle`, and `amount_paid > 0`
 * earns `amount_paid × INCLUDED_CREDITS_RATIO` — exactly what the shipped
 * resolver would have granted at the time. Deliberately NOT included:
 *   - `subscription_create` invoices. The activation path
 *     (`activateOnFirstInvoicePaid`) was never broken and already granted the
 *     machine bonus; only the RENEWAL branch under-granted.
 *   - $0 invoices (100%-off coupons, $0 prices). No money moved, so nothing is
 *     owed. The forward rule agrees: 0 × ratio = 0.
 *
 * AUTHORITY IS STRIPE, NOT OUR DB. The amount is read from the invoices that
 * actually settled, never estimated from a price × a cycle count — on the real
 * population those disagree constantly (coupons, mid-period upgrades, partial
 * proration), and a per-account estimate would have been wrong for most of them.
 *
 * IDEMPOTENT BY CONSTRUCTION. Each grant is keyed
 * `legacy_renewal_backfill:v1:<invoiceId>` in `credit_ledger.stripe_event_id`,
 * which carries a UNIQUE index (`kortix_unique_stripe_event`). Re-running can
 * therefore never double-pay, and a run interrupted halfway resumes cleanly.
 * The script also pre-checks the ledger for that key: `atomic_add_credits`
 * only dedupes keys seen in the last hour, so long-window idempotency has to be
 * the caller's job (see grantCredits' own note).
 *
 * Usage (a human, with prod env):
 *   dotenvx run -f apps/api/.env.prod -- bun apps/api/src/scripts/backfill-legacy-renewal-credits.ts
 *   dotenvx run -f apps/api/.env.prod -- bun apps/api/src/scripts/backfill-legacy-renewal-credits.ts --apply
 *   ... [--account <uuid>]
 *
 * SAFETY: dry-run by default. `--apply` writes real credit to real customers.
 */

import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { creditAccounts, creditLedger } from '@kortix/db';
import Stripe from 'stripe';
import { db } from '../shared/db';
import { getStripe } from '../shared/stripe';
import { grantCredits } from '../billing/services/credits';
import { INCLUDED_CREDITS_RATIO, getMonthlyCredits } from '../billing/services/tiers';

const KEY_PREFIX = 'legacy_renewal_backfill:v1:';

/**
 * Backfilled credit EXPIRES, like the renewal grant it stands in for.
 *
 * A real renewal calls `resetExpiringCredits`, so the grants these customers
 * missed would each have expired at their next cycle — replaying them with
 * their historical expiry would hand back credit that is already worthless.
 * Granting them non-expiring would instead be strictly more generous than the
 * thing being restored. This window is the middle: the full value they paid
 * for, with a fresh, usable runway to spend it in.
 */
const EXPIRY_DAYS = 30;

interface Owed {
  accountId: string;
  subscriptionId: string;
  tier: string;
  invoices: Array<{ id: string; paidUsd: number; creditsUsd: number; created: string }>;
  totalCreditsUsd: number;
  alreadyPaidUsd: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const account = argv.includes('--account') ? argv[argv.indexOf('--account') + 1] : null;
  return { apply: argv.includes('--apply'), account };
}

/**
 * Affected = a live legacy subscription on a paid tier whose catalog grant is
 * 0. Derived from the catalog rather than hardcoding 'pro', so a second
 * zero-grant tier can never be silently missed.
 */
async function findAffectedAccounts(accountFilter: string | null) {
  const rows = await db
    .select({
      accountId: creditAccounts.accountId,
      tier: creditAccounts.tier,
      subscriptionId: creditAccounts.stripeSubscriptionId,
      balance: creditAccounts.balance,
    })
    .from(creditAccounts)
    .where(
      and(
        isNotNull(creditAccounts.stripeSubscriptionId),
        inArray(creditAccounts.stripeSubscriptionStatus, ['active', 'trialing']),
        ne(creditAccounts.billingModel, 'per_seat'),
        ne(creditAccounts.billingModel, 'credit'),
        sql`${creditAccounts.tier} NOT IN ('free','none')`,
        accountFilter ? eq(creditAccounts.accountId, accountFilter) : sql`true`,
      ),
    );

  return rows.filter((r) => getMonthlyCredits(r.tier ?? 'free') === 0);
}

/** Ledger keys already written by a previous run, so we never re-grant. */
async function alreadyGrantedKeys(accountIds: string[]): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set();
  const rows = await db
    .select({ key: creditLedger.stripeEventId })
    .from(creditLedger)
    .where(
      and(
        inArray(creditLedger.accountId, accountIds),
        sql`${creditLedger.stripeEventId} LIKE ${KEY_PREFIX + '%'}`,
      ),
    );
  return new Set(rows.map((r) => r.key).filter((k): k is string => !!k));
}

async function computeOwed(
  stripe: Stripe,
  account: { accountId: string; tier: string | null; subscriptionId: string | null },
  done: Set<string>,
): Promise<Owed | null> {
  const subscriptionId = account.subscriptionId!;
  let invoices: Stripe.Invoice[];
  try {
    const list = await stripe.invoices.list({ subscription: subscriptionId, limit: 100 });
    invoices = list.data;
  } catch (err) {
    console.error(
      `  ! ${account.accountId}: could not list invoices for ${subscriptionId}: ${(err as Error).message}`,
    );
    return null;
  }

  const owed: Owed = {
    accountId: account.accountId,
    subscriptionId,
    tier: account.tier ?? 'unknown',
    invoices: [],
    totalCreditsUsd: 0,
    alreadyPaidUsd: 0,
  };

  for (const inv of invoices) {
    if (inv.status !== 'paid') continue;
    if (inv.billing_reason !== 'subscription_cycle') continue;
    const paidUsd = (inv.amount_paid ?? 0) / 100;
    if (paidUsd <= 0) continue;

    const credits = round2(paidUsd * INCLUDED_CREDITS_RATIO);
    if (done.has(`${KEY_PREFIX}${inv.id}`)) {
      owed.alreadyPaidUsd = round2(owed.alreadyPaidUsd + credits);
      continue;
    }
    owed.invoices.push({
      id: inv.id!,
      paidUsd,
      creditsUsd: credits,
      created: new Date((inv.created ?? 0) * 1000).toISOString().slice(0, 10),
    });
    owed.totalCreditsUsd = round2(owed.totalCreditsUsd + credits);
  }

  return owed;
}

async function main() {
  const { apply, account: accountFilter } = parseArgs();
  const stripe = getStripe();

  console.log(`mode: ${apply ? 'APPLY (writes real credit)' : 'DRY RUN'}`);
  console.log(`included-credits ratio: ${INCLUDED_CREDITS_RATIO}\n`);

  const affected = await findAffectedAccounts(accountFilter);
  console.log(`candidate accounts (live legacy sub, paid tier, zero catalog grant): ${affected.length}`);

  const done = await alreadyGrantedKeys(affected.map((a) => a.accountId));
  if (done.size > 0) console.log(`already-backfilled invoice grants found: ${done.size}`);

  const results: Owed[] = [];
  for (const a of affected) {
    const owed = await computeOwed(stripe, a, done);
    if (owed) results.push(owed);
  }

  const payable = results.filter((r) => r.invoices.length > 0);
  // Two very different reasons an account is not payable, and collapsing them
  // makes a re-run read as though customers were never owed anything.
  const settled = results.filter((r) => r.invoices.length === 0 && r.alreadyPaidUsd > 0);
  const neverPaid = results.length - payable.length - settled.length;
  const total = round2(payable.reduce((s, r) => s + r.totalCreditsUsd, 0));
  const cycles = payable.reduce((s, r) => s + r.invoices.length, 0);

  console.log(`\naccounts owed credit : ${payable.length}`);
  console.log(`already backfilled   : ${settled.length}  (settled by an earlier run — nothing to do)`);
  console.log(`accounts owed nothing: ${neverPaid}  (never paid a cycle — $0 price or 100%-off coupon)`);
  console.log(`unpaid renewal cycles: ${cycles}`);
  console.log(`TOTAL TO GRANT       : $${total.toFixed(2)}\n`);

  for (const r of payable.sort((a, b) => b.totalCreditsUsd - a.totalCreditsUsd)) {
    const paid = round2(r.invoices.reduce((s, i) => s + i.paidUsd, 0));
    console.log(
      `  ${r.accountId}  tier=${r.tier}  cycles=${r.invoices.length}  paid=$${paid.toFixed(2)}  ->  grant $${r.totalCreditsUsd.toFixed(2)}` +
        (r.alreadyPaidUsd > 0 ? `  (already backfilled $${r.alreadyPaidUsd.toFixed(2)})` : ''),
    );
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to grant.');
    return;
  }

  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  console.log(`\napplying... (credit expires ${expiresAt.slice(0, 10)}, ${EXPIRY_DAYS} days out)`);
  let granted = 0;
  let failed = 0;
  for (const r of payable) {
    for (const inv of r.invoices) {
      const key = `${KEY_PREFIX}${inv.id}`;
      try {
        await grantCredits(
          r.accountId,
          inv.creditsUsd,
          'legacy_renewal_backfill',
          `Renewal credit for ${inv.created} (invoice ${inv.id}, $${inv.paidUsd.toFixed(2)} paid) — not granted at the time`,
          true, // expiring, like the renewal grant it replaces
          key,
          { expiresAt },
        );
        granted++;
      } catch (err) {
        failed++;
        console.error(`  ! ${r.accountId} ${inv.id}: ${(err as Error).message}`);
      }
    }
  }
  console.log(`\ngrants written: ${granted}  failed: ${failed}  total: $${total.toFixed(2)}`);
}

await main();
