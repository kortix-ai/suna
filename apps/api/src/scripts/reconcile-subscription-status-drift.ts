#!/usr/bin/env bun
/**
 * Reconcile `credit_accounts.stripe_subscription_status` against Stripe.
 *
 * WHY THIS MATTERS NOW. A row that says `active` while Stripe says `canceled`
 * used to be nearly harmless: the wallet floor gated those accounts anyway, so
 * a stale status cost us nothing at a $0 balance. PR #6662 changed that. The
 * floor bypass now reads exactly this column — a paying subscription on a paid
 * plan spends without a floor — so every stale `active` row becomes a grant of
 * unmetered spend the moment that change reaches an environment.
 *
 * Found while computing the #6662 backfill: 5 rows on production claimed
 * `active` for subscriptions Stripe had already canceled.
 *
 * SCOPE. Only accounts that would GAIN something from a stale row: a DB status
 * of `active`/`trialing` on a paid tier, or on a per-seat/credit billing model.
 * Deliberately NOT a full-table scan — the free tier alone holds ~227k rows
 * with a live $0 subscription, and one Stripe call each would be both slow and
 * pointless (a free row grants no bypass either way).
 *
 * FIXES VIA THE PRODUCT'S OWN PATH. Each repair calls `syncSubscription()`,
 * the same service `POST /v1/billing/sync-subscription` uses, rather than
 * writing the column directly — so the row lands exactly as the product would
 * leave it (status AND billing cycle anchor), not as a hand-patched half-state.
 *
 * Usage (a human, with prod env):
 *   dotenvx run -f apps/api/.env.prod -- bun apps/api/src/scripts/reconcile-subscription-status-drift.ts
 *   dotenvx run -f apps/api/.env.prod -- bun apps/api/src/scripts/reconcile-subscription-status-drift.ts --apply
 *
 * SAFETY: read-only by default; `--apply` writes. Stripe is the source of truth
 * in both directions — a row that reads MORE dead than Stripe is drift too, and
 * is reported (it silently denies service to someone who is paying).
 */

import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import { creditAccounts } from '@kortix/db';
import { db } from '../shared/db';
import { getStripe } from '../shared/stripe';
import { syncSubscription } from '../billing/services/subscriptions';

const LIVE_IN_DB = ['active', 'trialing'];

interface Drift {
  accountId: string;
  subscriptionId: string;
  tier: string | null;
  billingModel: string | null;
  dbStatus: string;
  stripeStatus: string;
  balance: string | null;
  /**
   * A DIFFERENT subscription on the same Stripe customer that is live right
   * now. When this is set the account is NOT stale-and-dead — it moved, and
   * the row simply points at the superseded subscription.
   */
  newerActiveSubId: string | null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const stripe = getStripe();

  console.log(`mode: ${apply ? 'APPLY (writes credit_accounts rows)' : 'DRY RUN'}\n`);

  const candidates = await db
    .select({
      accountId: creditAccounts.accountId,
      subscriptionId: creditAccounts.stripeSubscriptionId,
      tier: creditAccounts.tier,
      billingModel: creditAccounts.billingModel,
      dbStatus: creditAccounts.stripeSubscriptionStatus,
      balance: creditAccounts.balance,
    })
    .from(creditAccounts)
    .where(
      and(
        isNotNull(creditAccounts.stripeSubscriptionId),
        inArray(creditAccounts.stripeSubscriptionStatus, LIVE_IN_DB),
        // Only rows that would gain a wallet-floor bypass from being stale.
        sql`(${creditAccounts.tier} NOT IN ('free','none')
             OR ${creditAccounts.billingModel} IN ('per_seat','credit'))`,
      ),
    );

  console.log(`candidates (DB says live, and a stale row would grant a bypass): ${candidates.length}`);

  const drifted: Drift[] = [];
  let checked = 0;
  let errors = 0;

  for (const c of candidates) {
    checked++;
    if (checked % 50 === 0) console.log(`  ...checked ${checked}/${candidates.length}`);
    try {
      const sub = await stripe.subscriptions.retrieve(c.subscriptionId!);
      if (sub.status !== c.dbStatus) {
        // Before calling this row stale, ask whether the customer simply MOVED.
        // `syncSubscription` only ever syncs the recorded id, so on an account
        // that switched subscriptions it would stamp `canceled` onto someone
        // who is actively paying — a false cancellation, which is far worse
        // than the stale row we came here to fix. Detect and refuse instead.
        const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
        let newerActiveSubId: string | null = null;
        if (customerId) {
          const live = await stripe.subscriptions.list({
            customer: customerId,
            status: 'active',
            limit: 10,
          });
          newerActiveSubId = live.data.find((s) => s.id !== c.subscriptionId)?.id ?? null;
        }
        drifted.push({
          accountId: c.accountId,
          subscriptionId: c.subscriptionId!,
          tier: c.tier,
          billingModel: c.billingModel,
          dbStatus: c.dbStatus!,
          stripeStatus: sub.status,
          balance: c.balance,
          newerActiveSubId,
        });
      }
    } catch (err) {
      errors++;
      console.error(`  ! ${c.accountId}: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  console.log(`\nchecked: ${checked}   drifted: ${drifted.length}   lookup errors: ${errors}\n`);

  const safe = drifted.filter((d) => !d.newerActiveSubId);
  const moved = drifted.filter((d) => d.newerActiveSubId);

  for (const d of safe) {
    console.log(
      `  ${d.accountId}  tier=${d.tier}  db=${d.dbStatus} -> stripe=${d.stripeStatus}  balance=${d.balance}`,
    );
  }

  if (moved.length > 0) {
    console.log(`\n!! ${moved.length} account(s) point at a SUPERSEDED subscription — NOT touched:`);
    for (const d of moved) {
      console.log(
        `  ${d.accountId}  recorded=${d.subscriptionId} (${d.stripeStatus})  live now=${d.newerActiveSubId}`,
      );
    }
    console.log('  These need the row REPOINTED at the live subscription, not a status sync.');
    console.log('  Syncing them would stamp `canceled` on a paying customer. Handle by hand.');
  }

  if (drifted.length === 0) {
    console.log('no drift — nothing to do.');
    return;
  }

  if (!apply) {
    console.log(`\nDRY RUN — nothing written. --apply would reconcile ${safe.length}, skip ${moved.length}.`);
    return;
  }

  console.log(`\nreconciling ${safe.length} via syncSubscription()...`);
  let fixed = 0;
  let failed = 0;
  for (const d of safe) {
    try {
      await syncSubscription(d.accountId);
      fixed++;
    } catch (err) {
      failed++;
      console.error(`  ! ${d.accountId}: ${(err as Error).message.slice(0, 100)}`);
    }
  }
  console.log(`\nreconciled: ${fixed}   failed: ${failed}   skipped (superseded): ${moved.length}`);
}

await main();
