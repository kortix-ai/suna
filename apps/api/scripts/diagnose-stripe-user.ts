/**
 * Diagnose why a paying Stripe user has no kortix.credit_accounts row
 * (and therefore no "Claim computer" button on the web).
 *
 * Calls the same syncLegacyStripeSubscription() path that resolveAccountId
 * runs on every authed request — so this tells you exactly why the user's
 * row isn't being created automatically:
 *   - no_customer                 → no billing_customers mapping for the account
 *   - no_active_paid_subscription → Stripe has no active paid sub for the customer(s)
 *   - would_sync / synced         → sync works, just needs to be triggered
 *   - error                       → Stripe API error
 *
 * Requires STRIPE_SECRET_KEY and DATABASE_URL in env.
 *
 * Usage:
 *   bun run scripts/diagnose-stripe-user.ts <email>           # dry run
 *   bun run scripts/diagnose-stripe-user.ts <email> --apply   # commit the sync if it would succeed
 */

import { sql as drizzleSql } from 'drizzle-orm';
import { db } from '../src/shared/db';
import { syncLegacyStripeSubscription } from '../src/billing/services/legacy-stripe-sync';

const email = process.argv[2]?.trim().toLowerCase();
const apply = process.argv.includes('--apply');

if (!email || email.startsWith('--')) {
  console.error('Usage: bun run scripts/diagnose-stripe-user.ts <email> [--apply]');
  process.exit(1);
}

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
)) as unknown as Array<{ user_id: string; account_id: string }>;

const rows = Array.isArray(userRows) ? userRows : (userRows as any).rows ?? [];

if (rows.length === 0) {
  console.error(`No user/account found for email=${email}`);
  process.exit(2);
}
if (rows.length > 1) {
  console.error(`Ambiguous: ${email} maps to multiple accounts.`);
  console.error(JSON.stringify(rows, null, 2));
  process.exit(3);
}

const { user_id: userId, account_id: accountId } = rows[0];

const kortixRow = (await db.execute(
  drizzleSql`select tier, provider, stripe_subscription_id, stripe_subscription_status, payment_status from kortix.credit_accounts where account_id = ${accountId}::uuid limit 1`,
)) as any;
const legacyRow = (await db.execute(
  drizzleSql`select tier, provider, stripe_subscription_id, stripe_subscription_status, payment_status, commitment_type, revenuecat_product_id from public.credit_accounts where account_id = ${accountId}::uuid limit 1`,
)) as any;
const customers = (await db.execute(
  drizzleSql`select id, email, provider, active from kortix.billing_customers where account_id = ${accountId}::uuid order by active desc nulls last`,
)) as any;
const legacyCustomers = (await db.execute(
  drizzleSql`select id, email, provider, active from basejump.billing_customers where account_id = ${accountId}::uuid order by active desc nulls last`,
)) as any;

const pick = (r: any) => (Array.isArray(r) ? r : r?.rows ?? []);

console.log(JSON.stringify({
  email,
  userId,
  accountId,
  kortix_credit_accounts: pick(kortixRow)[0] ?? null,
  legacy_public_credit_accounts: pick(legacyRow)[0] ?? null,
  kortix_billing_customers: pick(customers),
  basejump_billing_customers: pick(legacyCustomers),
}, null, 2));

console.log('\n--- Running syncLegacyStripeSubscription ---');
const result = await syncLegacyStripeSubscription(accountId, { dryRun: !apply });
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...result }, null, 2));

console.log('\n--- Checking RevenueCat ---');
const rcKey = process.env.REVENUECAT_API_KEY || process.env.REVENUECAT_SECRET_API_KEY;
if (!rcKey) {
  console.log('Skipped: set REVENUECAT_API_KEY (or REVENUECAT_SECRET_API_KEY) to check RevenueCat.');
} else {
  const candidates = [userId, accountId];
  for (const appUserId of candidates) {
    try {
      const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`, {
        headers: { Authorization: `Bearer ${rcKey}`, Accept: 'application/json' },
      });
      const body = await res.json().catch(() => ({}));
      const subscriber = (body as any)?.subscriber ?? null;
      const entitlements = subscriber?.entitlements ?? {};
      const subscriptions = subscriber?.subscriptions ?? {};
      const activeEntitlements = Object.entries(entitlements).filter(([, v]: any) => {
        const expires = v?.expires_date ? new Date(v.expires_date).getTime() : Infinity;
        return expires > Date.now();
      });
      const activeSubscriptions = Object.entries(subscriptions).filter(([, v]: any) => {
        const expires = v?.expires_date ? new Date(v.expires_date).getTime() : Infinity;
        return expires > Date.now() && v?.unsubscribe_detected_at == null;
      });

      console.log(JSON.stringify({
        app_user_id: appUserId,
        http_status: res.status,
        original_app_user_id: subscriber?.original_app_user_id ?? null,
        first_seen: subscriber?.first_seen ?? null,
        active_entitlements: activeEntitlements.map(([k, v]: any) => ({ id: k, product_identifier: v?.product_identifier, expires_date: v?.expires_date })),
        active_subscriptions: activeSubscriptions.map(([k, v]: any) => ({
          product_identifier: k,
          store: v?.store,
          expires_date: v?.expires_date,
          period_type: v?.period_type,
          billing_issues_detected_at: v?.billing_issues_detected_at,
        })),
      }, null, 2));

      if (activeEntitlements.length > 0 || activeSubscriptions.length > 0) {
        console.log(`→ RevenueCat has an active record under app_user_id=${appUserId}. The kortix row is missing because the webhook never landed (or failed).`);
        break;
      }
    } catch (err) {
      console.log(`RC check failed for app_user_id=${appUserId}:`, err instanceof Error ? err.message : err);
    }
  }
}

process.exit(0);
