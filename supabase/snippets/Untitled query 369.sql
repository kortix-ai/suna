DO $$
DECLARE
  acct uuid;
BEGIN
  SELECT am.account_id INTO acct
  FROM auth.users u
  JOIN kortix.account_members am ON am.user_id = u.id
  WHERE u.email = 'sutharjay3635@gmail.com'
  LIMIT 1;

  IF acct IS NULL THEN
    RAISE EXCEPTION 'No account found for user';
  END IF;

  INSERT INTO kortix.credit_accounts (
    account_id, tier, billing_model, plan_type, balance,
    expiring_credits, non_expiring_credits,
    stripe_subscription_status, payment_status, updated_at
  ) VALUES (
    acct, 'pro', 'legacy', 'monthly', '999.0000', '999.0000', '0.0000',
    'active', 'active', now()
  )
  ON CONFLICT (account_id) DO UPDATE SET
    tier = 'pro', billing_model = 'legacy', plan_type = 'monthly',
    balance = '999.0000', expiring_credits = '999.0000',
    non_expiring_credits = '0.0000',
    stripe_subscription_status = 'active', payment_status = 'active',
    updated_at = now();

  RAISE NOTICE 'Granted pro to account %', acct;
END $$;