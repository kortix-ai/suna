-- Migration: Proper Daily Credits Tracking
-- This migration implements correct deduction order: Daily → Monthly → Extra
-- 
-- Credit Types:
--   - daily_credits_balance: Refreshes every X hours (configurable per tier)
--   - expiring_credits: Monthly credits that refresh at billing cycle
--   - non_expiring_credits: Extra/purchased credits that never expire

-- Step 1: Add daily_credits_balance column back
ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS daily_credits_balance NUMERIC(10, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN credit_accounts.daily_credits_balance IS 'Daily credits that refresh based on tier-specific interval (e.g., every 24h). Consumed FIRST before monthly/extra credits.';

-- Step 2: Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_credit_accounts_daily_balance 
ON credit_accounts(account_id, daily_credits_balance) 
WHERE daily_credits_balance > 0;

-- Step 3: Update atomic_use_credits to use correct deduction order: Daily → Monthly → Extra
CREATE OR REPLACE FUNCTION atomic_use_credits(
    p_account_id UUID,
    p_amount NUMERIC(10, 2),
    p_description TEXT DEFAULT 'Credit usage',
    p_thread_id TEXT DEFAULT NULL,
    p_message_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_daily_balance NUMERIC(10, 2);
    v_expiring_balance NUMERIC(10, 2);
    v_non_expiring_balance NUMERIC(10, 2);
    v_total_balance NUMERIC(10, 2);
    v_amount_from_daily NUMERIC(10, 2) := 0;
    v_amount_from_expiring NUMERIC(10, 2) := 0;
    v_amount_from_non_expiring NUMERIC(10, 2) := 0;
    v_remaining NUMERIC(10, 2);
    v_new_daily NUMERIC(10, 2);
    v_new_expiring NUMERIC(10, 2);
    v_new_non_expiring NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_transaction_id UUID;
BEGIN
    -- Lock the row and get current balances
    SELECT 
        COALESCE(daily_credits_balance, 0),
        COALESCE(expiring_credits, 0),
        COALESCE(non_expiring_credits, 0),
        COALESCE(balance, 0)
    INTO 
        v_daily_balance,
        v_expiring_balance,
        v_non_expiring_balance,
        v_total_balance
    FROM public.credit_accounts
    WHERE account_id = p_account_id
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'No credit account found',
            'required', p_amount,
            'available', 0
        );
    END IF;
    
    v_remaining := p_amount;
    
    -- Step 1: Deduct from DAILY credits first
    IF v_remaining > 0 AND v_daily_balance > 0 THEN
        IF v_daily_balance >= v_remaining THEN
            v_amount_from_daily := v_remaining;
            v_remaining := 0;
        ELSE
            v_amount_from_daily := v_daily_balance;
            v_remaining := v_remaining - v_daily_balance;
        END IF;
    END IF;
    
    -- Step 2: Deduct from MONTHLY (expiring) credits second
    IF v_remaining > 0 AND v_expiring_balance > 0 THEN
        IF v_expiring_balance >= v_remaining THEN
            v_amount_from_expiring := v_remaining;
            v_remaining := 0;
        ELSE
            v_amount_from_expiring := v_expiring_balance;
            v_remaining := v_remaining - v_expiring_balance;
        END IF;
    END IF;
    
    -- Step 3: Deduct from EXTRA (non-expiring) credits last
    IF v_remaining > 0 THEN
        v_amount_from_non_expiring := v_remaining;
        v_remaining := 0;
    END IF;
    
    -- Calculate new balances (can go negative for non_expiring if needed)
    v_new_daily := v_daily_balance - v_amount_from_daily;
    v_new_expiring := v_expiring_balance - v_amount_from_expiring;
    v_new_non_expiring := v_non_expiring_balance - v_amount_from_non_expiring;
    v_new_total := v_new_daily + v_new_expiring + v_new_non_expiring;
    
    -- Update the credit account
    UPDATE public.credit_accounts
    SET 
        daily_credits_balance = v_new_daily,
        expiring_credits = v_new_expiring,
        non_expiring_credits = v_new_non_expiring,
        balance = v_new_total,
        updated_at = NOW()
    WHERE account_id = p_account_id;
    
    -- Record the transaction in ledger
    INSERT INTO public.credit_ledger (
        account_id, 
        amount, 
        balance_after, 
        type, 
        description,
        metadata
    ) VALUES (
        p_account_id,
        -p_amount,
        v_new_total,
        'usage',
        p_description,
        jsonb_build_object(
            'from_daily', v_amount_from_daily,
            'from_monthly', v_amount_from_expiring,
            'from_extra', v_amount_from_non_expiring,
            'thread_id', p_thread_id,
            'message_id', p_message_id
        )
    )
    RETURNING id INTO v_transaction_id;
    
    RETURN jsonb_build_object(
        'success', true,
        'amount_deducted', p_amount,
        'new_total', v_new_total,
        'new_daily', v_new_daily,
        'new_expiring', v_new_expiring,
        'new_non_expiring', v_new_non_expiring,
        'from_daily', v_amount_from_daily,
        'from_monthly', v_amount_from_expiring,
        'from_extra', v_amount_from_non_expiring,
        'from_expiring', v_amount_from_expiring,
        'from_non_expiring', v_amount_from_non_expiring,
        'transaction_id', v_transaction_id
    );
END;
$$ LANGUAGE plpgsql;

-- Step 4: Update atomic_daily_credit_refresh to only refresh daily balance (not reset monthly!)
CREATE OR REPLACE FUNCTION atomic_daily_credit_refresh(
    p_account_id UUID,
    p_credit_amount NUMERIC(10, 2),
    p_tier TEXT,
    p_processed_by TEXT,
    p_refresh_interval_hours INTEGER DEFAULT 24
)
RETURNS JSONB
SECURITY DEFINER
AS $$
DECLARE
    v_last_refresh TIMESTAMPTZ;
    v_now TIMESTAMPTZ := NOW();
    v_refresh_date DATE := v_now::DATE;
    v_already_refreshed BOOLEAN;
    v_interval INTERVAL;
    v_should_refresh BOOLEAN := FALSE;
    v_old_daily NUMERIC(10, 2);
    v_old_total NUMERIC(10, 2);
    v_new_daily NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_tracking_id UUID;
    v_credits_added NUMERIC(10, 2);
BEGIN
    v_interval := (p_refresh_interval_hours || ' hours')::INTERVAL;
    
    -- Lock and get current state
    SELECT last_daily_refresh, daily_credits_balance, balance
    INTO v_last_refresh, v_old_daily, v_old_total
    FROM credit_accounts
    WHERE account_id = p_account_id
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'account_not_found',
            'duplicate_prevented', false
        );
    END IF;
    
    -- Check if already refreshed today (using tracking table for idempotency)
    SELECT EXISTS(
        SELECT 1 FROM daily_refresh_tracking
        WHERE account_id = p_account_id
        AND refresh_date = v_refresh_date
    ) INTO v_already_refreshed;
    
    IF v_already_refreshed THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'already_refreshed_today',
            'duplicate_prevented', true,
            'refresh_date', v_refresh_date
        );
    END IF;
    
    -- Check if interval has elapsed
    IF v_last_refresh IS NULL THEN
        v_should_refresh := TRUE;
    ELSIF v_now - v_last_refresh > v_interval THEN
        v_should_refresh := TRUE;
    END IF;
    
    IF NOT v_should_refresh THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'interval_not_elapsed',
            'duplicate_prevented', false,
            'last_refresh', v_last_refresh,
            'next_refresh', v_last_refresh + v_interval
        );
    END IF;
    
    -- Insert tracking record (idempotency check)
    INSERT INTO daily_refresh_tracking (
        account_id,
        refresh_date,
        credits_granted,
        tier,
        processed_by
    ) VALUES (
        p_account_id,
        v_refresh_date,
        p_credit_amount,
        p_tier,
        p_processed_by
    )
    ON CONFLICT (account_id, refresh_date) DO NOTHING
    RETURNING id INTO v_tracking_id;
    
    IF v_tracking_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'concurrent_refresh_prevented',
            'duplicate_prevented', true,
            'refresh_date', v_refresh_date
        );
    END IF;
    
    -- Reset daily credits to the configured amount (don't touch monthly!)
    v_new_daily := p_credit_amount;
    v_credits_added := p_credit_amount - COALESCE(v_old_daily, 0);
    v_new_total := v_old_total + v_credits_added;
    
    UPDATE credit_accounts
    SET
        daily_credits_balance = v_new_daily,
        balance = v_new_total,
        last_daily_refresh = v_now,
        updated_at = v_now
    WHERE account_id = p_account_id;
    
    -- Log to ledger
    INSERT INTO credit_ledger (
        account_id,
        amount,
        balance_after,
        type,
        description,
        is_expiring,
        expires_at,
        metadata
    ) VALUES (
        p_account_id,
        v_credits_added,
        v_new_total,
        'daily_refresh',
        format('Daily credits refresh: %s → %s', COALESCE(v_old_daily, 0), v_new_daily),
        TRUE,
        v_now + v_interval,
        jsonb_build_object(
            'tier', p_tier,
            'refresh_date', v_refresh_date,
            'old_daily', v_old_daily,
            'new_daily', v_new_daily,
            'refresh_interval_hours', p_refresh_interval_hours,
            'tracking_id', v_tracking_id
        )
    );
    
    RAISE NOTICE '[DAILY REFRESH] Account % daily credits: % → % (total: %)', 
        p_account_id, v_old_daily, v_new_daily, v_new_total;
    
    RETURN jsonb_build_object(
        'success', true,
        'credits_granted', v_credits_added,
        'new_daily_balance', v_new_daily,
        'new_total_balance', v_new_total,
        'refresh_date', v_refresh_date,
        'old_daily', v_old_daily,
        'duplicate_prevented', false,
        'tracking_id', v_tracking_id
    );
END;
$$ LANGUAGE plpgsql;

-- Step 5: Helper function to get full credit breakdown
CREATE OR REPLACE FUNCTION get_credit_breakdown(
    p_account_id UUID
)
RETURNS TABLE(
    total NUMERIC(10, 2),
    daily NUMERIC(10, 2),
    monthly NUMERIC(10, 2),
    extra NUMERIC(10, 2)
)
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COALESCE(ca.balance, 0) as total,
        COALESCE(ca.daily_credits_balance, 0) as daily,
        COALESCE(ca.expiring_credits, 0) as monthly,
        COALESCE(ca.non_expiring_credits, 0) as extra
    FROM credit_accounts ca
    WHERE ca.account_id = p_account_id;
END;
$$ LANGUAGE plpgsql;

-- Step 6: Update atomic_grant_renewal_credits to account for daily_credits_balance
-- This function handles monthly credit renewal from Stripe/RevenueCat webhooks
CREATE OR REPLACE FUNCTION atomic_grant_renewal_credits(
    p_account_id UUID,
    p_period_start BIGINT,
    p_period_end BIGINT,
    p_credits NUMERIC(10, 2),
    p_processed_by TEXT,
    p_invoice_id TEXT DEFAULT NULL,
    p_stripe_event_id TEXT DEFAULT NULL,
    p_provider TEXT DEFAULT 'stripe',
    p_revenuecat_transaction_id TEXT DEFAULT NULL,
    p_revenuecat_product_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_already_processed BOOLEAN;
    v_existing_processor TEXT;
    v_current_daily NUMERIC(10, 2);
    v_current_non_expiring NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_expires_at TIMESTAMP WITH TIME ZONE;
    v_subscription_id TEXT;
BEGIN
    -- Check if this period was already processed (idempotency)
    SELECT EXISTS(
        SELECT 1 FROM public.renewal_processing 
        WHERE account_id = p_account_id 
        AND period_start = p_period_start
    ), (
        SELECT processed_by FROM public.renewal_processing
        WHERE account_id = p_account_id
        AND period_start = p_period_start
        LIMIT 1
    ) INTO v_already_processed, v_existing_processor;
    
    IF v_already_processed THEN
        RAISE NOTICE '[ATOMIC RENEWAL] Period % already processed by % for account %', 
            p_period_start, v_existing_processor, p_account_id;
        
        RETURN jsonb_build_object(
            'success', false, 
            'reason', 'already_processed',
            'processed_by', v_existing_processor,
            'duplicate_prevented', true
        );
    END IF;
    
    -- Get subscription_id based on provider
    IF p_provider = 'revenuecat' THEN
        SELECT COALESCE(revenuecat_subscription_id, 'unknown')
        INTO v_subscription_id
        FROM public.credit_accounts
        WHERE account_id = p_account_id;
    ELSE
        SELECT COALESCE(stripe_subscription_id, 'unknown')
        INTO v_subscription_id
        FROM public.credit_accounts
        WHERE account_id = p_account_id;
    END IF;
    
    -- Insert processing record (idempotency lock)
    INSERT INTO public.renewal_processing (
        account_id, 
        period_start, 
        period_end, 
        subscription_id,
        processed_by, 
        credits_granted, 
        stripe_event_id,
        provider,
        revenuecat_transaction_id,
        revenuecat_product_id
    ) VALUES (
        p_account_id,
        p_period_start,
        p_period_end,
        v_subscription_id,
        p_processed_by,
        p_credits,
        p_stripe_event_id,
        p_provider,
        p_revenuecat_transaction_id,
        p_revenuecat_product_id
    );
    
    RAISE NOTICE '[ATOMIC RENEWAL] Marked period % as processing by % for account % (provider: %)',
        p_period_start, p_processed_by, p_account_id, p_provider;
    
    -- Get current balances (including daily!)
    SELECT 
        COALESCE(daily_credits_balance, 0),
        COALESCE(non_expiring_credits, 0)
    INTO v_current_daily, v_current_non_expiring
    FROM public.credit_accounts
    WHERE account_id = p_account_id;
    
    -- Total = daily + monthly (new) + extra
    v_new_total := v_current_daily + p_credits + v_current_non_expiring;
    v_expires_at := TO_TIMESTAMP(p_period_end);
    
    -- Update: reset monthly credits, keep daily and extra intact
    UPDATE public.credit_accounts 
    SET 
        expiring_credits = p_credits,
        balance = v_new_total,
        last_grant_date = TO_TIMESTAMP(p_period_start),
        next_credit_grant = TO_TIMESTAMP(p_period_end),
        last_processed_invoice_id = COALESCE(p_invoice_id, last_processed_invoice_id),
        last_renewal_period_start = p_period_start,
        updated_at = NOW()
    WHERE account_id = p_account_id;
    
    -- Log to ledger
    INSERT INTO public.credit_ledger (
        account_id,
        amount,
        balance_after,
        type,
        description,
        is_expiring,
        expires_at,
        stripe_event_id,
        processing_source
    ) VALUES (
        p_account_id,
        p_credits,
        v_new_total,
        'tier_grant',
        'Monthly renewal: ' || p_processed_by,
        true,
        v_expires_at,
        p_stripe_event_id,
        p_processed_by
    );
    
    RAISE NOTICE '[ATOMIC RENEWAL] Granted % monthly credits to account %, new balance: % (daily: %, extra: %)',
        p_credits, p_account_id, v_new_total, v_current_daily, v_current_non_expiring;
    
    RETURN jsonb_build_object(
        'success', true,
        'credits_granted', p_credits,
        'new_balance', v_new_total,
        'daily_credits', v_current_daily,
        'expiring_credits', p_credits,
        'non_expiring_credits', v_current_non_expiring,
        'processed_by', p_processed_by,
        'provider', p_provider
    );
    
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[ATOMIC RENEWAL] Error: % - %', SQLERRM, SQLSTATE;
    RETURN jsonb_build_object(
        'success', false,
        'reason', 'error',
        'error', SQLERRM
    );
END;
$$ LANGUAGE plpgsql;

-- Grant permissions
GRANT EXECUTE ON FUNCTION atomic_use_credits(UUID, NUMERIC, TEXT, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION atomic_daily_credit_refresh(UUID, NUMERIC, TEXT, TEXT, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_credit_breakdown(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION atomic_grant_renewal_credits(UUID, BIGINT, BIGINT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

