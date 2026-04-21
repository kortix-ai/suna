/**
 * Verify a user's post-backfill state:
 *  - kortix.credit_accounts row
 *  - recent kortix.credit_ledger entries
 *  - active/provisioning sandboxes
 *  - computed can_claim_computer (same rule as buildMinimalAccountState)
 *
 * Read-only. Use after running backfill-revenuecat-user.ts --apply (or any time
 * you want to sanity-check a user's billing/claim state).
 *
 * Usage:
 *   bun run scripts/verify-revenuecat-user.ts <email>
 */

import { sql as drizzleSql } from 'drizzle-orm';
import { db } from '../src/shared/db';
import { isLegacyPaidTier } from '../src/billing/services/tiers';

const email = process.argv[2]?.trim().toLowerCase();

if (!email || email.startsWith('--')) {
  console.error('Usage: bun run scripts/verify-revenuecat-user.ts <email>');
  process.exit(1);
}

const pick = (r: any) => (Array.isArray(r) ? r : r?.rows ?? []);

const userRows = pick(await db.execute(
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
));

if (userRows.length === 0) {
  console.error(`No user/account found for email=${email}`);
  process.exit(2);
}
if (userRows.length > 1) {
  console.error('Ambiguous: multiple accounts for this email');
  console.error(JSON.stringify(userRows, null, 2));
  process.exit(3);
}

const { user_id: userId, account_id: accountId } = userRows[0];

const kortixAccount = pick(await db.execute(
  drizzleSql`
    select
      tier, provider, payment_status, plan_type,
      balance, expiring_credits, non_expiring_credits, daily_credits_balance,
      stripe_subscription_id, stripe_subscription_status,
      revenuecat_customer_id, revenuecat_subscription_id, revenuecat_product_id,
      revenuecat_cancelled_at, revenuecat_cancel_at_period_end,
      auto_topup_enabled, auto_topup_threshold, auto_topup_amount,
      created_at, updated_at, last_grant_date
    from kortix.credit_accounts
    where account_id = ${accountId}::uuid
    limit 1
  `,
))[0] ?? null;

const ledger = pick(await db.execute(
  drizzleSql`
    select
      type, amount, balance_after, is_expiring,
      description, idempotency_key, created_at
    from kortix.credit_ledger
    where account_id = ${accountId}::uuid
    order by created_at desc
    limit 10
  `,
));

const sandboxesRows = pick(await db.execute(
  drizzleSql`
    select sandbox_id::text, name, status, provider, created_at
    from kortix.sandboxes
    where account_id = ${accountId}::uuid
    order by created_at desc
  `,
));

const hasActiveMachine = sandboxesRows.some((s: any) => s.status === 'active' || s.status === 'provisioning');
const tier = kortixAccount?.tier ?? 'free';
const canClaimComputer = isLegacyPaidTier(tier) && !hasActiveMachine;

const expectedBalance = (Number(kortixAccount?.expiring_credits ?? 0))
  + (Number(kortixAccount?.non_expiring_credits ?? 0))
  + (Number(kortixAccount?.daily_credits_balance ?? 0));
const actualBalance = Number(kortixAccount?.balance ?? 0);
const balanceConsistent = Math.abs(expectedBalance - actualBalance) < 0.0001;

console.log(JSON.stringify({
  email,
  userId,
  accountId,
  kortix_credit_accounts: kortixAccount,
  balance_consistent: balanceConsistent,
  balance_components_sum: expectedBalance,
  recent_ledger_entries: ledger,
  sandboxes: sandboxesRows,
  has_active_machine: hasActiveMachine,
  tier,
  is_legacy_paid_tier: isLegacyPaidTier(tier),
  can_claim_computer: canClaimComputer,
}, null, 2));

console.log('\n--- Verdict ---');
if (!kortixAccount) {
  console.log('❌  No kortix.credit_accounts row. Run backfill-revenuecat-user.ts first.');
  process.exit(10);
}
if (kortixAccount.payment_status !== 'active') {
  console.log(`⚠️   payment_status=${kortixAccount.payment_status} (expected 'active').`);
}
if (!balanceConsistent) {
  console.log(`⚠️   Balance (${actualBalance}) does not equal expiring+nonExpiring+daily (${expectedBalance}).`);
}
if (canClaimComputer) {
  console.log('✅  Claim button WILL appear on /instances.');
} else if (hasActiveMachine) {
  console.log('ℹ️   Claim button hidden because user already has an active/provisioning machine.');
} else {
  console.log(`❌  Claim button HIDDEN. tier='${tier}' is not in LEGACY_PAID_TIERS.`);
}

process.exit(0);
