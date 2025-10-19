-- QUICK BILLING DIAGNOSIS
-- Run this directly in your production Supabase SQL Editor

-- 1. Check recent webhook events
SELECT 
    event_type,
    status,
    created_at,
    error_message
FROM webhook_events 
ORDER BY created_at DESC 
LIMIT 20;

-- 2. Check if atomic functions exist
SELECT routine_name, routine_type
FROM information_schema.routines 
WHERE routine_schema = 'public' 
AND routine_name LIKE '%credit%'
ORDER BY routine_name;

-- 3. Check for the specific problematic account
SELECT 
    account_id,
    balance,
    tier,
    stripe_subscription_id,
    trial_status,
    last_processed_invoice_id,
    last_grant_date,
    created_at,
    updated_at
FROM credit_accounts 
WHERE account_id = '91d183d9-53a3-4b66-ac00-011267c820e6';

-- 4. Check credit ledger for this account
SELECT 
    type,
    amount,
    description,
    balance_after,
    created_at,
    stripe_event_id
FROM credit_ledger 
WHERE account_id = '91d183d9-53a3-4b66-ac00-011267c820e6'
ORDER BY created_at DESC
LIMIT 10;

-- 5. Check if there's a Stripe customer for this account
SELECT 
    bc.id as stripe_customer_id,
    bc.account_id,
    bc.email
FROM basejump.billing_customers bc
WHERE bc.account_id = '91d183d9-53a3-4b66-ac00-011267c820e6';

-- 6. Check RLS policies on credit_accounts
SELECT 
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual
FROM pg_policies 
WHERE tablename IN ('credit_accounts', 'credit_ledger', 'webhook_events')
ORDER BY tablename, policyname;

-- 7. Check for any failed webhooks in last 24 hours
SELECT COUNT(*) as failed_webhook_count
FROM webhook_events 
WHERE status = 'failed' 
AND created_at > NOW() - INTERVAL '24 hours';

-- 8. Find ALL accounts with paid subscriptions but zero balance (potential victims)
SELECT 
    ca.account_id,
    ca.tier,
    ca.balance,
    ca.stripe_subscription_id,
    ca.created_at,
    ca.updated_at
FROM credit_accounts ca
WHERE ca.stripe_subscription_id IS NOT NULL
AND ca.balance = 0
AND ca.tier IN ('tier_1_10', 'tier_2_20', 'tier_3_40', 'tier_4_75', 'tier_5_150')
ORDER BY ca.updated_at DESC;

