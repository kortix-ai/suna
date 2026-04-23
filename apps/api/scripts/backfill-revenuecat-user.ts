/**
 * Backfill a single RevenueCat subscriber into kortix.credit_accounts.
 *
 * Use when diagnose-stripe-user.ts shows the user has an active RevenueCat
 * entitlement but kortix.credit_accounts is empty — meaning the INITIAL_PURCHASE
 * webhook never landed, OR it landed but mapRevenueCatProductToTier() returned
 * null for the product_id (e.g. Play Store products like "plus" / "pro" / "ultra"
 * that our REVENUECAT_PRODUCT_MAPPING in tiers.ts doesn't cover).
 *
 * Replicates the DB/credit side of handleRevenueCatPurchase() in
 * billing/services/webhooks.ts:606 — upserts the credit account, grants the
 * tier's monthly credits + $5 machine bonus (idempotent).
 *
 * Requires: DATABASE_URL, REVENUECAT_API_KEY (v1 secret).
 *
 * Usage:
 *   bun run scripts/backfill-revenuecat-user.ts <email>            # dry run
 *   bun run scripts/backfill-revenuecat-user.ts <email> --apply    # commit
 */

import { sql as drizzleSql } from 'drizzle-orm';
import { db } from '../src/shared/db';
import { upsertCreditAccount, getCreditAccount } from '../src/billing/repositories/credit-accounts';
import { grantCredits } from '../src/billing/services/credits';
import { getTier, MACHINE_CREDIT_BONUS } from '../src/billing/services/tiers';
import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';

const email = process.argv[2]?.trim().toLowerCase();
const apply = process.argv.includes('--apply');

if (!email || email.startsWith('--')) {
  console.error('Usage: bun run scripts/backfill-revenuecat-user.ts <email> [--apply]');
  process.exit(1);
}

const rcKey = process.env.REVENUECAT_API_KEY || process.env.REVENUECAT_SECRET_API_KEY;
if (!rcKey) {
  console.error('REVENUECAT_API_KEY (v1 secret) is required');
  process.exit(1);
}

// Product identifier → canonical tier. Supersets the tiers.ts mapping to also
// handle bare Play Store product IDs we've seen in the wild.
const PRODUCT_TO_TIER: Record<string, string> = {
  plus: 'tier_2_20',
  kortix_plus_monthly: 'tier_2_20',
  kortix_plus_yearly: 'tier_2_20',
  'plus:plus-monthly': 'tier_2_20',

  pro: 'pro',
  kortix_pro_monthly: 'pro',
  kortix_pro_yearly: 'pro',
  'pro:pro-monthly': 'pro',

  ultra: 'tier_25_200',
  kortix_ultra_monthly: 'tier_25_200',
  kortix_ultra_yearly: 'tier_25_200',
  'ultra:ultra-monthly': 'tier_25_200',
};

const userRows = (await db.execute(
  drizzleSql`
    select
      u.id::text as user_id,
      coalesce(am.account_id, au.account_id)::text as account_id
    from auth.users u
    left join kortix.account_members am on am.user_id = u.id
    left join basejump.account_user au on au.user_id = u.id
    where lower(u.email) = ${email}
      and coalesce(am.account_id, au.account_id) is not null
    limit 2
  `,
)) as any;

const rows = Array.isArray(userRows) ? userRows : userRows?.rows ?? [];

if (rows.length === 0) {
  console.error(`No user/account found for email=${email}`);
  process.exit(2);
}
if (rows.length > 1) {
  console.error('Ambiguous: multiple accounts for this email');
  console.error(JSON.stringify(rows, null, 2));
  process.exit(3);
}

const { user_id: userId, account_id: accountId } = rows[0];

const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`, {
  headers: { Authorization: `Bearer ${rcKey}`, Accept: 'application/json' },
});

if (!res.ok) {
  console.error(`RC /v1/subscribers/${userId} → HTTP ${res.status}`);
  console.error(await res.text());
  process.exit(4);
}

const body = (await res.json()) as any;
const subscriber = body?.subscriber ?? null;
const subscriptions = subscriber?.subscriptions ?? {};

const now = Date.now();
const active = Object.entries(subscriptions)
  .map(([productId, v]: [string, any]) => ({
    productId,
    expiresAt: v?.expires_date ? new Date(v.expires_date).getTime() : Infinity,
    periodType: v?.period_type,
    store: v?.store,
    unsubscribedAt: v?.unsubscribe_detected_at ?? null,
    originalPurchaseDate: v?.original_purchase_date ?? null,
  }))
  .filter((s) => s.expiresAt > now && s.unsubscribedAt == null)
  .sort((a, b) => b.expiresAt - a.expiresAt);

if (active.length === 0) {
  console.error('No active RevenueCat subscription found for this user.');
  process.exit(5);
}

const chosen = active[0];
const tierKey = PRODUCT_TO_TIER[chosen.productId.toLowerCase()];

if (!tierKey) {
  console.error(`Unknown product_id from RC: "${chosen.productId}". Add it to PRODUCT_TO_TIER before applying.`);
  process.exit(6);
}

const tier = getTier(tierKey);
const existing = await getCreditAccount(accountId);

// Monthly vs yearly from the product id — fall back to monthly.
const lowerId = chosen.productId.toLowerCase();
const periodType: 'monthly' | 'yearly' = lowerId.includes('yearly') || lowerId.includes('annual') ? 'yearly' : 'monthly';

const planned = {
  accountId,
  userId,
  tierKey,
  displayName: tier.displayName,
  monthlyCredits: tier.monthlyCredits,
  machineBonus: MACHINE_CREDIT_BONUS,
  productId: chosen.productId,
  store: chosen.store,
  planType: periodType,
  expiresAt: new Date(chosen.expiresAt).toISOString(),
  existingKortixRow: existing
    ? { tier: existing.tier, provider: existing.provider, paymentStatus: existing.paymentStatus }
    : null,
};

console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...planned }, null, 2));

if (existing?.provider === 'revenuecat' && existing?.tier === tierKey && existing?.paymentStatus === 'active') {
  console.log('Already has a matching active RevenueCat credit_accounts row. Nothing to do.');
  process.exit(0);
}

if (!apply) {
  console.log('Dry run. Re-run with --apply to upsert the kortix.credit_accounts row and grant credits.');
  process.exit(0);
}

await upsertCreditAccount(accountId, {
  tier: tierKey,
  provider: 'revenuecat',
  paymentStatus: 'active',
  planType: periodType,
  revenuecatProductId: chosen.productId,
  revenuecatCustomerId: userId,
  revenuecatSubscriptionId: userId,
  stripeSubscriptionId: null,
  stripeSubscriptionStatus: null,
  autoTopupEnabled: true,
  autoTopupThreshold: String(AUTO_TOPUP_DEFAULT_THRESHOLD),
  autoTopupAmount: String(AUTO_TOPUP_DEFAULT_AMOUNT),
});

if (tier.monthlyCredits > 0) {
  await grantCredits(
    accountId,
    tier.monthlyCredits,
    'tier_grant',
    `${tier.displayName} subscription (mobile, backfill): ${tier.monthlyCredits} credits`,
    true,
    `tier_grant:revenuecat:backfill:${accountId}:${chosen.productId}`,
  );
}

if (MACHINE_CREDIT_BONUS > 0) {
  try {
    await grantCredits(
      accountId,
      MACHINE_CREDIT_BONUS,
      'machine_bonus',
      `Welcome credit bonus: $${MACHINE_CREDIT_BONUS}`,
      false,
      `machine_bonus:revenuecat:${accountId}:${chosen.productId}`,
    );
  } catch (err) {
    console.error('Machine bonus grant failed:', err);
  }
}

console.log(JSON.stringify({ success: true, accountId, tier: tierKey }, null, 2));
process.exit(0);
