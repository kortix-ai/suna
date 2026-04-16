import { sql } from 'drizzle-orm';
import { syncLegacyStripeSubscription } from '../billing/services/legacy-stripe-sync';
import { db } from '../shared/db';

type CandidateRow = {
  accountId: string;
  email: string | null;
  existingTier: string | null;
  existingProvider: string | null;
  existingStripeSubscriptionId: string | null;
};

function getArg(flag: string): string | null {
  const exact = Bun.argv.find((arg) => arg === flag);
  if (exact) {
    const index = Bun.argv.indexOf(exact);
    return Bun.argv[index + 1] ?? null;
  }

  const prefixed = Bun.argv.find((arg) => arg.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : null;
}

const apply = Bun.argv.includes('--apply');
const accountId = getArg('--account-id');
const email = getArg('--email');
const limit = Number(getArg('--limit') ?? '500');

const accountFilter = accountId ? sql`AND candidates.account_id = ${accountId}` : sql``;
const emailFilter = email ? sql`AND lower(candidates.email) = lower(${email})` : sql``;

const result = await db.execute(sql`
  WITH customer_accounts AS (
    SELECT account_id, email, COALESCE(provider, 'stripe') AS provider, COALESCE(active, true) AS active
    FROM kortix.billing_customers
    UNION ALL
    SELECT account_id, email, COALESCE(provider, 'stripe') AS provider, COALESCE(active, true) AS active
    FROM basejump.billing_customers
  ),
  candidates AS (
    SELECT
      customer_accounts.account_id,
      max(customer_accounts.email) AS email
    FROM customer_accounts
    WHERE customer_accounts.provider = 'stripe'
      AND customer_accounts.active = true
    GROUP BY customer_accounts.account_id
  )
  SELECT
    candidates.account_id AS "accountId",
    candidates.email AS "email",
    credit.tier AS "existingTier",
    credit.provider AS "existingProvider",
    credit.stripe_subscription_id AS "existingStripeSubscriptionId"
  FROM candidates
  LEFT JOIN kortix.credit_accounts credit
    ON credit.account_id = candidates.account_id
  WHERE (
    credit.account_id IS NULL
    OR credit.provider IS NULL
    OR credit.provider = 'stripe'
  )
  AND (
    credit.account_id IS NULL
    OR credit.stripe_subscription_id IS NULL
    OR credit.tier IS NULL
    OR credit.tier IN ('none', 'free')
  )
  ${accountFilter}
  ${emailFilter}
  ORDER BY candidates.account_id
  LIMIT ${Number.isFinite(limit) && limit > 0 ? limit : 500}
`);

const rows = (Array.isArray(result) ? result : (result as any).rows ?? []) as CandidateRow[];

const summary = {
  scanned: rows.length,
  wouldSync: 0,
  synced: 0,
  alreadySynced: 0,
  noCustomer: 0,
  noActivePaidSubscription: 0,
  errors: 0,
};

console.log(`[legacy-stripe-sync] mode=${apply ? 'apply' : 'dry-run'} candidates=${rows.length}`);

for (const row of rows) {
  const syncResult = await syncLegacyStripeSubscription(row.accountId, { dryRun: !apply });

  if (syncResult.status === 'would_sync') summary.wouldSync += 1;
  else if (syncResult.status === 'synced') summary.synced += 1;
  else if (syncResult.status === 'already_synced') summary.alreadySynced += 1;
  else if (syncResult.status === 'no_customer') summary.noCustomer += 1;
  else if (syncResult.status === 'no_active_paid_subscription') summary.noActivePaidSubscription += 1;
  else if (syncResult.status === 'error') summary.errors += 1;

  console.log(JSON.stringify({
    accountId: row.accountId,
    email: row.email,
    existingTier: row.existingTier,
    existingProvider: row.existingProvider,
    existingStripeSubscriptionId: row.existingStripeSubscriptionId,
    result: syncResult,
  }));
}

console.log(JSON.stringify({ summary }, null, 2));
