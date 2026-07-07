WITH target AS (
  SELECT id
  FROM auth.users
  WHERE lower(email) = lower('sutharjay3635@gmail.com')
),
credits AS (
  INSERT INTO kortix.credit_accounts (
    account_id, tier, plan_type, billing_model,
    balance, expiring_credits, non_expiring_credits,
    stripe_subscription_id, stripe_subscription_status, payment_status,
    updated_at
  )
  SELECT
    id, 'pro', 'monthly', 'legacy',
    99999.0000, 99999.0000, 0.0000,
    'local_manual_pro_grant', 'active', 'active',
    now()
  FROM target
  ON CONFLICT (account_id) DO UPDATE SET
    tier = EXCLUDED.tier,
    plan_type = EXCLUDED.plan_type,
    billing_model = EXCLUDED.billing_model,
    balance = EXCLUDED.balance,
    expiring_credits = EXCLUDED.expiring_credits,
    non_expiring_credits = EXCLUDED.non_expiring_credits,
    stripe_subscription_id = EXCLUDED.stripe_subscription_id,
    stripe_subscription_status = EXCLUDED.stripe_subscription_status,
    payment_status = EXCLUDED.payment_status,
    updated_at = now()
)
INSERT INTO kortix.platform_user_roles (account_id, role, granted_by)
SELECT id, 'super_admin', NULL
FROM target
ON CONFLICT (account_id) DO UPDATE
SET role = 'super_admin';
