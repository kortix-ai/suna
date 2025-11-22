# Yearly Plan End-to-End Testing Guide

## Overview
This guide walks you through testing the yearly plan renewal system before deploying to production.

---

## Prerequisites

1. **Staging Environment**: Use a staging database (NOT production)
2. **Stripe Test Mode**: Ensure you're using Stripe test API keys
3. **Test Credit Card**: Use Stripe's test card `4242 4242 4242 4242`

---

## Part 1: Initial Setup & Subscription Creation

### Step 1: Create a Test Subscription

1. **Navigate to pricing page** in your frontend (staging)
2. **Select Yearly billing period**
3. **Choose a tier** (e.g., Tier 6 - $50/month)
4. **Complete checkout** using Stripe test card
5. **Note down**:
   - Your account_id
   - Stripe subscription_id

### Step 2: Verify Database State

Run this query in Supabase SQL Editor:

```sql
SELECT 
    account_id,
    tier,
    plan_type,
    stripe_subscription_id,
    stripe_subscription_status,
    billing_cycle_anchor,
    next_credit_grant,
    expiring_credits,
    non_expiring_credits,
    balance
FROM credit_accounts
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';
```

**Expected Results:**
- `plan_type` = `'yearly'`
- `stripe_subscription_status` = `'active'`
- `billing_cycle_anchor` = timestamp of subscription start
- `next_credit_grant` = billing_cycle_anchor + 1 month (NOT 1 year)
- `expiring_credits` = monthly credit amount (e.g., 50 for tier_6_50)
- `balance` = same as expiring_credits (initial grant)

**✅ Checkpoint**: If all these match, your webhook integration is working correctly!

---

## Part 2: Testing Monthly Refills

### Step 3: Simulate Time Progression

Since you can't wait 30 days, manually update the database to simulate time passing:

```sql
-- Replace with your actual account_id
\set test_account_id '30a260be-4ade-4596-87bf-6cbd783b103d'

-- Simulate being 1 day past the first monthly renewal date
UPDATE credit_accounts
SET next_credit_grant = NOW() - INTERVAL '1 day'
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';

-- Verify the update
SELECT 
    account_id,
    tier,
    next_credit_grant,
    balance,
    expiring_credits
FROM credit_accounts
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';
```

### Step 4: Manually Trigger the Refill Function

```sql
-- Run the refill process
SELECT * FROM process_monthly_refills();
```

**Expected Output:**
```json
{
  "account_id": "12345678-...",
  "credits_granted": "50.00",
  "tier": "tier_6_50",
  "next_grant_date": "2025-12-22T...",
  "status": "success_month_2_of_12"
}
```

### Step 5: Verify the Refill Worked

```sql
-- Check credit_accounts
SELECT 
    account_id,
    tier,
    next_credit_grant,
    last_grant_date,
    expiring_credits,
    non_expiring_credits,
    balance
FROM credit_accounts
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';

-- Check credit_ledger for the transaction
SELECT 
    account_id,
    amount,
    balance_after,
    type,
    description,
    is_expiring,
    metadata,
    processing_source,
    created_at
FROM credit_ledger
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d'
ORDER BY created_at DESC
LIMIT 5;

-- Check renewal_processing for idempotency record
SELECT 
    account_id,
    period_start,
    period_end,
    processed_by,
    credits_granted,
    processed_at
FROM renewal_processing
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d'
ORDER BY processed_at DESC;
```

**Expected Results:**
- `expiring_credits` = monthly amount (50)
- `balance` = monthly amount (50) + any unused non_expiring_credits
- `next_credit_grant` = moved forward by 1 month
- `last_grant_date` = NOW()
- New entry in `credit_ledger` with `processing_source = 'cron'`
- New entry in `renewal_processing` with `processed_by = 'cron'`

---

## Part 3: Testing Idempotency

### Step 6: Test Duplicate Prevention

Run the refill function again **without** updating `next_credit_grant`:

```sql
SELECT * FROM process_monthly_refills();
```

**Expected Output:**
```json
{
  "account_id": "12345678-...",
  "credits_granted": "0",
  "tier": "tier_6_50",
  "next_grant_date": null,
  "status": "already_processed_by_cron"
}
```

**✅ Checkpoint**: Credits should NOT be granted again. Balance should remain unchanged.

---

## Part 4: Testing the 12-Month Limit

### Step 7: Fast-Forward to Month 11

```sql
-- IMPORTANT: Do this in TWO steps because SQL uses OLD values in the same UPDATE

-- Step 7a: Move billing_cycle_anchor back to 11 months ago
UPDATE credit_accounts
SET billing_cycle_anchor = NOW() - INTERVAL '11 months'
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';

-- Step 7b: Set next_credit_grant to be ready for month 12 (should be in the past to trigger refill)
UPDATE credit_accounts
SET next_credit_grant = billing_cycle_anchor + INTERVAL '11 months'
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';

-- Verify the dates make sense
SELECT 
    account_id,
    billing_cycle_anchor,
    next_credit_grant,
    next_credit_grant <= NOW() as "should_process",
    EXTRACT(MONTH FROM AGE(next_credit_grant, billing_cycle_anchor))::INT + 
    (EXTRACT(YEAR FROM AGE(next_credit_grant, billing_cycle_anchor))::INT * 12) as "months_since_start"
FROM credit_accounts
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';

-- Clear previous idempotency records for testing
DELETE FROM renewal_processing
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';
```

### Step 8: Grant Month 12 Credits

```sql
SELECT * FROM process_monthly_refills();
```

**Expected Output:**
```json
{
  "status": "success_month_12_of_12"
}
```

### Step 9: Try to Grant Month 13 (Should Stop)

After Step 8, check where next_credit_grant is:

```sql
SELECT 
    billing_cycle_anchor,
    next_credit_grant,
    billing_cycle_anchor + INTERVAL '1 year' as year_end,
    EXTRACT(MONTH FROM AGE(next_credit_grant, billing_cycle_anchor))::INT + 
    (EXTRACT(YEAR FROM AGE(next_credit_grant, billing_cycle_anchor))::INT * 12) as months_since_start
FROM credit_accounts
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';
```

The function should have moved `next_credit_grant` forward by 1 month after granting month 12. Now we need to make it processable (in the past) but keep it at 12+ months:

```sql
-- Don't delete the renewal record! Just move next_credit_grant to the past while keeping it at 12 months
-- Method 1: If next_credit_grant is already at 12+ months but in the future, subtract a year
UPDATE credit_accounts
SET next_credit_grant = next_credit_grant - INTERVAL '1 year'
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';

-- OR Method 2: Set it explicitly to billing_cycle_anchor + 12 months (in the past)
UPDATE credit_accounts
SET next_credit_grant = billing_cycle_anchor + INTERVAL '12 months'
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';

-- Verify it's at 12+ months and in the past
SELECT 
    next_credit_grant,
    next_credit_grant <= NOW() as "ready_to_process",
    EXTRACT(MONTH FROM AGE(next_credit_grant, billing_cycle_anchor))::INT + 
    (EXTRACT(YEAR FROM AGE(next_credit_grant, billing_cycle_anchor))::INT * 12) as months_since_start
FROM credit_accounts
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';
-- Should show: ready_to_process = true, months_since_start = 12

-- Now try to grant (should be blocked because months >= 12)
SELECT * FROM process_monthly_refills();
```

**Expected Output:**
```json
{
  "status": "yearly_period_complete_awaiting_stripe_renewal",
  "credits_granted": "0"
}
```

**Verify:**
```sql
SELECT 
    account_id,
    next_credit_grant,
    billing_cycle_anchor,
    billing_cycle_anchor + INTERVAL '1 year' as year_end_date
FROM credit_accounts
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';
```

- `next_credit_grant` should now equal `billing_cycle_anchor + 1 year`
- No credits should have been granted
- No new entry in `renewal_processing`

**✅ Checkpoint**: System correctly stops at 12 months!

---

## Part 5: Testing Subscription Status

### Step 10: Test Inactive Subscription

```sql
-- Simulate an inactive subscription
UPDATE credit_accounts
SET 
    stripe_subscription_status = 'past_due',
    next_credit_grant = NOW() - INTERVAL '1 day'
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';

-- Try to refill
SELECT * FROM process_monthly_refills();
```

**Expected**: No credits granted, account should be skipped entirely.

### Step 11: Reactivate and Test

```sql
-- Reactivate
UPDATE credit_accounts
SET stripe_subscription_status = 'active'
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';

-- Try again
SELECT * FROM process_monthly_refills();
```

**Expected**: Credits should now be granted.

---

## Part 6: Testing Plan Changes

### Step 12: Test Mid-Cycle Upgrade

1. **In Stripe Dashboard (Test Mode)**:
   - Find the subscription
   - Change the price to a higher tier
   - Set proration behavior to "create prorations" 
   - Schedule change for "end of billing period"

2. **Verify in Database**:
```sql
-- Tier should NOT change yet
SELECT tier, next_credit_grant
FROM credit_accounts
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';
```

3. **Simulate the billing period end**:
   - Wait for Stripe webhook (subscription.updated)
   - Or manually update tier for testing:

```sql
UPDATE credit_accounts
SET tier = 'tier_7_100'
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';
```

4. **Run next refill**:
```sql
SELECT * FROM process_monthly_refills();
```

**Expected**: New tier amount (100) should be granted, not old amount (50).

---

## Part 7: Testing Cancellation

### Step 13: Test End-of-Period Cancellation

1. **In Stripe Dashboard**:
   - Cancel the subscription
   - Select "at end of billing period"

2. **Before period ends**:
```sql
-- Subscription should still be active
SELECT stripe_subscription_status, next_credit_grant
FROM credit_accounts
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';

-- Refills should still work
SELECT * FROM process_monthly_refills();
```

3. **After period ends** (webhook fires):
```sql
-- Status should update to canceled
-- next_credit_grant should stop updating
SELECT 
    stripe_subscription_status,
    next_credit_grant,
    balance
FROM credit_accounts
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';
```

---

## Part 8: Testing the Cron Job

### Step 14: Verify Cron Schedule

```sql
SELECT 
    jobname,
    schedule,
    command,
    nodename,
    nodeport,
    database,
    username,
    active,
    jobid
FROM cron.job
WHERE jobname = 'yearly-plan-monthly-refill';
```

**Expected**:
- `schedule` = `'0 1 * * *'` (daily at 1 AM UTC)
- `active` = `true`
- `command` = `SELECT process_monthly_refills();`

### Step 15: Check Cron History

```sql
SELECT 
    jobid,
    runid,
    job_pid,
    database,
    username,
    command,
    status,
    return_message,
    start_time,
    end_time
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'yearly-plan-monthly-refill')
ORDER BY start_time DESC
LIMIT 10;
```

---

## Clean Up After Testing

```sql
-- Reset your test account to initial state
UPDATE credit_accounts
SET 
    next_credit_grant = billing_cycle_anchor + INTERVAL '1 month',
    stripe_subscription_status = 'active',
    expiring_credits = (SELECT monthly_credits FROM tiers WHERE tier = credit_accounts.tier),
    balance = (SELECT monthly_credits FROM tiers WHERE tier = credit_accounts.tier)
WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';

-- Optional: Delete test data
DELETE FROM renewal_processing WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';
DELETE FROM credit_ledger WHERE account_id = 'dfce759a-ee30-42f1-88df-574c0655587d';
```

---

## Testing Checklist

Before deploying to production, verify:

- [ ] Webhook creates yearly plan with correct `plan_type`
- [ ] Initial credits granted on subscription creation
- [ ] `next_credit_grant` set to 1 month (not 1 year) after billing_cycle_anchor
- [ ] Manual refill function works correctly
- [ ] Idempotency prevents duplicate grants
- [ ] 12-month limit stops credits after year
- [ ] Inactive subscriptions don't get refills
- [ ] Mid-cycle upgrades work (tier change at period end)
- [ ] Cancellations work (status update, refills stop)
- [ ] Cron job is scheduled correctly
- [ ] `renewal_processing` tracks all grants

---

## What to Monitor in Production

After deployment, watch:

1. **Cron job execution**:
   ```sql
   SELECT * FROM cron.job_run_details 
   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'yearly-plan-monthly-refill')
   ORDER BY start_time DESC LIMIT 5;
   ```

2. **Failed refills**:
   ```sql
   SELECT * FROM process_monthly_refills() WHERE status LIKE 'error%';
   ```

3. **Yearly accounts due for refill**:
   ```sql
   SELECT COUNT(*) FROM credit_accounts
   WHERE plan_type = 'yearly' 
   AND next_credit_grant <= NOW() + INTERVAL '1 day'
   AND stripe_subscription_status = 'active';
   ```

---

## Rollback Plan

If issues occur in production:

1. **Disable the cron job**:
   ```sql
   SELECT cron.unschedule('yearly-plan-monthly-refill');
   ```

2. **Prevent new yearly subscriptions** (temporarily):
   - Hide yearly option in frontend
   - Or add feature flag

3. **Investigate** using the monitoring queries above

4. **Re-enable** after fixes:
   ```sql
   SELECT cron.schedule(
       'yearly-plan-monthly-refill',
       '0 1 * * *',
       $$SELECT process_monthly_refills();$$
   );
   ```

