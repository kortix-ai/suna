-- Part 3: Update atomic_daily_credit_refresh function
-- This function only refreshes daily balance (not reset monthly!)

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

