# Billing Issue Fix - Quick Start

## The Problem
Users pay for subscriptions but credits aren't granted, so they can't use the app.

## Immediate Fix (5 minutes)

### 1. Run the fix script
```bash
cd /Users/saumya/Desktop/suna
python fix_billing.py 91d183d9-53a3-4b66-ac00-011267c820e6
```

This will:
- Check the account status
- Find the problem
- **Automatically fix it** if possible

### 2. Run the SQL diagnosis (in Supabase SQL Editor)
```bash
cat quick_diagnosis.sql
```

Copy the queries and run them in your **production** Supabase SQL Editor.

## Most Likely Causes (Production-only issues)

### Issue #1: Webhooks Not Being Received (90% likely)

**Check:** Run the fix script above - if it says "NO WEBHOOKS FOUND", this is it.

**Why it happens:**
- Webhook endpoint URL is wrong
- STRIPE_WEBHOOK_SECRET doesn't match
- Firewall blocking Stripe

**Fix:**

1. **Go to Stripe Dashboard (LIVE mode)**:
   - Developers → Webhooks
   - Click on your endpoint
   - Check "Recent deliveries" tab

2. **If deliveries are failing:**
   - Check the error message
   - Verify URL: `https://your-prod-domain.com/api/billing/webhook`
   - Click "Signing secret" → Compare with your `STRIPE_WEBHOOK_SECRET` env var

3. **If no deliveries at all:**
   - Webhook endpoint is not receiving requests
   - Check if URL is publicly accessible
   - Check firewall/security group rules

4. **Fix in production:**
   ```bash
   # In production .env, verify these match Stripe LIVE mode:
   STRIPE_SECRET_KEY=sk_live_...  # NOT sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_... # From your LIVE webhook endpoint
   ```

### Issue #2: Database Migration Not Applied (5% likely)

**Check:**
```sql
-- Run in Supabase SQL Editor
SELECT routine_name FROM information_schema.routines 
WHERE routine_name = 'atomic_add_credits';
```

**If empty:** Migration not applied

**Fix:**
```bash
cd /Users/saumya/Desktop/suna/backend
supabase db push  # Push migrations to production
```

### Issue #3: RLS Policy Blocking Service Role (3% likely)

**Check:**
```sql
SELECT policyname, cmd FROM pg_policies 
WHERE tablename = 'credit_accounts' 
AND 'service_role' = ANY(roles);
```

**Should see:** A policy allowing service_role

**If not:** RLS is blocking the backend

**Fix:** Already in migrations, just push them:
```bash
supabase db push
```

### Issue #4: Wrong Stripe Keys (2% likely)

**Check:** Are you using test keys in production?

```bash
# In production, check:
echo $STRIPE_SECRET_KEY | head -c 8
# Should be: sk_live_

# NOT sk_test_
```

**Fix:** Update production environment variables

## Quick Checks

### Check #1: Are webhooks arriving?
```sql
SELECT COUNT(*) FROM webhook_events WHERE created_at > NOW() - INTERVAL '1 day';
```
- If 0: Webhooks not configured
- If > 0: Webhooks are working

### Check #2: Are they failing?
```sql
SELECT COUNT(*), status FROM webhook_events 
WHERE created_at > NOW() - INTERVAL '1 day'
GROUP BY status;
```
- If many "failed": Check error_message column
- If all "completed": Issue is elsewhere

### Check #3: Do atomic functions exist?
```sql
SELECT COUNT(*) FROM information_schema.routines 
WHERE routine_name LIKE 'atomic_%';
```
- Should be: 4 (atomic_add_credits, atomic_use_credits, atomic_grant_renewal_credits, atomic_reset_expiring_credits)
- If < 4: Run migrations

## Manual Fix (If script fails)

```python
import asyncio
import sys
sys.path.insert(0, '/Users/saumya/Desktop/suna/backend')

from core.services.supabase import DBConnection
from core.billing.credit_manager import credit_manager
from decimal import Decimal
from datetime import datetime, timezone, timedelta

async def fix():
    account_id = "91d183d9-53a3-4b66-ac00-011267c820e6"
    
    # Grant 20 credits (adjust based on their tier)
    result = await credit_manager.add_credits(
        account_id=account_id,
        amount=Decimal("20.00"),
        is_expiring=True,
        description="Manual fix: Payment received but webhook failed",
        expires_at=datetime.now(timezone.utc) + timedelta(days=30)
    )
    
    print(result)

asyncio.run(fix())
```

## Testing The Fix

After fixing, have the user:
1. **Refresh the app** (hard refresh: Cmd+Shift+R)
2. **Check their credits** in dashboard
3. **Try to use the app**

## Preventing This

### Monitor for failed webhooks:
```sql
CREATE OR REPLACE FUNCTION check_billing_health()
RETURNS TABLE(issue TEXT, count BIGINT) AS $$
BEGIN
    RETURN QUERY
    -- Failed webhooks in last hour
    SELECT 'failed_webhooks_1h'::TEXT, COUNT(*)
    FROM webhook_events 
    WHERE status = 'failed' 
    AND created_at > NOW() - INTERVAL '1 hour'
    
    UNION ALL
    
    -- Paid users with 0 balance
    SELECT 'zero_balance_paid_users'::TEXT, COUNT(*)
    FROM credit_accounts
    WHERE tier NOT IN ('none', 'free')
    AND balance = 0
    
    UNION ALL
    
    -- No webhooks in last hour (suspicious)
    SELECT 'no_webhooks_1h'::TEXT, 
        CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
    FROM webhook_events
    WHERE created_at > NOW() - INTERVAL '1 hour';
END;
$$ LANGUAGE plpgsql;

-- Run every 15 minutes, alert if any issue > 0
SELECT * FROM check_billing_health();
```

### Set up alerts for:
- Webhook failure rate > 10%
- Any paid subscription with balance = 0 for > 5 minutes
- No webhook events for > 1 hour

## Still Not Working?

1. **Check application logs** for webhook processing errors
2. **Check Stripe Dashboard** → Events → Find the payment event → Check webhook delivery
3. **Run the SQL diagnosis** (quick_diagnosis.sql) and send output
4. **Check if it's an environment mismatch** (test keys in prod)

