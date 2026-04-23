/**
 * One-off: unlock the "Claim computer" button on the web for a single user
 * who subscribed to Pro via RevenueCat (tier='pro', provider='revenuecat').
 *
 * Why this is needed:
 *   can_claim_computer in account-state.ts is gated on isLegacyPaidTier(tier).
 *   RevenueCat's Pro product maps to tier='pro' (new flow, 0 monthly credits,
 *   $5-per-machine bonus only), which is NOT a legacy tier. So the button
 *   never appears for RC Pro subscribers.
 *
 * What this script does:
 *   Flips kortix.credit_accounts.tier from 'pro' → 'tier_6_50' for the target
 *   account. tier_6_50 IS a legacy tier, so isLegacyPaidTier() returns true
 *   and the button appears. tier_6_50 also matches the mobile advertisement
 *   for Pro ($50/mo, 100 credits).
 *
 * Side effect to be aware of:
 *   The next RevenueCat renewal webhook will read account.tier and grant
 *   getMonthlyCredits('tier_6_50') = 100 credits/mo instead of the 0 that
 *   tier='pro' would grant. If the user re-subscribes (initial purchase
 *   event, not renewal), the product→tier mapping will flip them back to
 *   'pro' and re-break the button.
 *
 * Usage:
 *   bun run scripts/unlock-claim-for-user.ts <email>            # dry run
 *   bun run scripts/unlock-claim-for-user.ts <email> --apply    # commit
 */

import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const email = process.argv[2]?.trim().toLowerCase();
const apply = process.argv.includes('--apply');

if (!email || email.startsWith('--')) {
  console.error('Usage: bun run scripts/unlock-claim-for-user.ts <email> [--apply]');
  process.exit(1);
}

const TARGET_TIER = 'tier_6_50';

const sql = postgres(databaseUrl, { max: 1 });

try {
  const rows = await sql<{
    user_id: string;
    account_id: string;
    tier: string | null;
    provider: string | null;
    revenuecat_product_id: string | null;
    payment_status: string | null;
  }[]>`
    select
      u.id::text as user_id,
      am.account_id::text as account_id,
      ca.tier,
      ca.provider,
      ca.revenuecat_product_id,
      ca.payment_status
    from auth.users u
    join public.account_members am on am.user_id = u.id
    left join kortix.credit_accounts ca on ca.account_id = am.account_id
    where lower(u.email) = ${email}
    limit 2
  `;

  if (rows.length === 0) {
    console.error(`No user/account found for email=${email}`);
    process.exit(2);
  }

  if (rows.length > 1) {
    console.error(`Ambiguous: ${email} maps to multiple accounts. Resolve manually.`);
    console.error(JSON.stringify(rows, null, 2));
    process.exit(3);
  }

  const row = rows[0];

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    email,
    ...row,
    target_tier: TARGET_TIER,
  }, null, 2));

  if (row.provider !== 'revenuecat') {
    console.error(`Refusing: provider=${row.provider}, expected 'revenuecat'. Not safe to flip tier for non-RC accounts.`);
    process.exit(4);
  }

  if (row.tier !== 'pro') {
    console.error(`Nothing to do: tier=${row.tier}. Button is only blocked when tier='pro'.`);
    process.exit(0);
  }

  if (!apply) {
    console.log(`Dry run: would update kortix.credit_accounts.tier from 'pro' to '${TARGET_TIER}' for account_id=${row.account_id}.`);
    console.log('Re-run with --apply to commit.');
    process.exit(0);
  }

  const [updated] = await sql<{ account_id: string; tier: string }[]>`
    update kortix.credit_accounts
    set tier = ${TARGET_TIER}, updated_at = now()
    where account_id = ${row.account_id}::uuid
      and tier = 'pro'
      and provider = 'revenuecat'
    returning account_id::text as account_id, tier
  `;

  if (!updated) {
    console.error('Update affected 0 rows (tier or provider changed between read and write). Re-run.');
    process.exit(5);
  }

  console.log(JSON.stringify({ success: true, ...updated }, null, 2));
} finally {
  await sql.end();
}
