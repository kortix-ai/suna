import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const apply = process.argv.includes('--apply');
const sql = postgres(databaseUrl, { max: 1 });

try {
  const [stats] = await sql<{
    legacy_revenuecat_rows: string;
    missing_kortix_rows: string;
    placeholder_kortix_rows: string;
  }[]>`
    with legacy as (
      select *
      from public.credit_accounts
      where provider = 'revenuecat'
        and tier not in ('free', 'none')
    )
    select
      (select count(*)::text from legacy) as legacy_revenuecat_rows,
      (
        select count(*)::text
        from legacy l
        left join kortix.credit_accounts k on k.account_id = l.account_id
        where k.account_id is null
      ) as missing_kortix_rows,
      (
        select count(*)::text
        from legacy l
        join kortix.credit_accounts k on k.account_id = l.account_id
        where coalesce(k.tier, 'free') in ('free', 'none')
      ) as placeholder_kortix_rows
  `;

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...stats }, null, 2));

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to sync RevenueCat legacy rows into kortix.credit_accounts.');
    process.exit(0);
  }

  const result = await sql<{
    inserted_or_updated: string;
  }[]>`
    with legacy as (
      select *
      from public.credit_accounts
      where provider = 'revenuecat'
        and tier not in ('free', 'none')
    ), upserted as (
      insert into kortix.credit_accounts (
        account_id,
        balance,
        lifetime_granted,
        lifetime_purchased,
        lifetime_used,
        created_at,
        updated_at,
        last_grant_date,
        tier,
        billing_cycle_anchor,
        next_credit_grant,
        stripe_subscription_id,
        expiring_credits,
        non_expiring_credits,
        daily_credits_balance,
        trial_status,
        trial_started_at,
        trial_ends_at,
        is_grandfathered_free,
        last_processed_invoice_id,
        commitment_type,
        commitment_start_date,
        commitment_end_date,
        commitment_price_id,
        can_cancel_after,
        last_renewal_period_start,
        payment_status,
        last_payment_failure,
        scheduled_tier_change,
        scheduled_tier_change_date,
        scheduled_price_id,
        provider,
        revenuecat_customer_id,
        revenuecat_subscription_id,
        revenuecat_cancelled_at,
        revenuecat_cancel_at_period_end,
        revenuecat_pending_change_product,
        revenuecat_pending_change_date,
        revenuecat_pending_change_type,
        revenuecat_product_id,
        plan_type,
        stripe_subscription_status,
        last_daily_refresh,
        auto_topup_enabled,
        auto_topup_threshold,
        auto_topup_amount,
        auto_topup_last_charged
      )
      select
        account_id,
        balance,
        lifetime_granted,
        lifetime_purchased,
        lifetime_used,
        created_at,
        now(),
        last_grant_date,
        tier,
        billing_cycle_anchor,
        next_credit_grant,
        null,
        expiring_credits,
        non_expiring_credits,
        daily_credits_balance,
        trial_status,
        trial_started_at,
        trial_ends_at,
        is_grandfathered_free,
        last_processed_invoice_id,
        commitment_type,
        commitment_start_date,
        commitment_end_date,
        commitment_price_id,
        can_cancel_after,
        last_renewal_period_start,
        coalesce(payment_status, 'active'),
        last_payment_failure,
        scheduled_tier_change,
        scheduled_tier_change_date,
        scheduled_price_id,
        'revenuecat',
        revenuecat_customer_id,
        revenuecat_subscription_id,
        revenuecat_cancelled_at,
        revenuecat_cancel_at_period_end,
        revenuecat_pending_change_product,
        revenuecat_pending_change_date,
        revenuecat_pending_change_type,
        revenuecat_product_id,
        coalesce(plan_type, 'monthly'),
        null,
        last_daily_refresh,
        true,
        1,
        5,
        null
      from legacy
      on conflict (account_id) do update
      set
        updated_at = now(),
        tier = excluded.tier,
        provider = 'revenuecat',
        payment_status = excluded.payment_status,
        revenuecat_customer_id = coalesce(excluded.revenuecat_customer_id, kortix.credit_accounts.revenuecat_customer_id),
        revenuecat_subscription_id = coalesce(excluded.revenuecat_subscription_id, kortix.credit_accounts.revenuecat_subscription_id),
        revenuecat_cancelled_at = excluded.revenuecat_cancelled_at,
        revenuecat_cancel_at_period_end = excluded.revenuecat_cancel_at_period_end,
        revenuecat_pending_change_product = excluded.revenuecat_pending_change_product,
        revenuecat_pending_change_date = excluded.revenuecat_pending_change_date,
        revenuecat_pending_change_type = excluded.revenuecat_pending_change_type,
        revenuecat_product_id = excluded.revenuecat_product_id,
        plan_type = excluded.plan_type,
        stripe_subscription_id = null,
        stripe_subscription_status = null,
        balance = case
          when coalesce(kortix.credit_accounts.tier, 'free') in ('free', 'none')
            and coalesce(kortix.credit_accounts.balance, 0) = 0
          then excluded.balance
          else kortix.credit_accounts.balance
        end,
        expiring_credits = case
          when coalesce(kortix.credit_accounts.tier, 'free') in ('free', 'none')
            and coalesce(kortix.credit_accounts.expiring_credits, 0) = 0
          then excluded.expiring_credits
          else kortix.credit_accounts.expiring_credits
        end,
        non_expiring_credits = case
          when coalesce(kortix.credit_accounts.tier, 'free') in ('free', 'none')
            and coalesce(kortix.credit_accounts.non_expiring_credits, 0) = 0
          then excluded.non_expiring_credits
          else kortix.credit_accounts.non_expiring_credits
        end,
        daily_credits_balance = case
          when coalesce(kortix.credit_accounts.tier, 'free') in ('free', 'none')
            and coalesce(kortix.credit_accounts.daily_credits_balance, 0) = 0
          then excluded.daily_credits_balance
          else kortix.credit_accounts.daily_credits_balance
        end
      returning 1
    )
    select count(*)::text as inserted_or_updated from upserted
  `;

  console.log(JSON.stringify(result[0], null, 2));
} finally {
  await sql.end();
}
