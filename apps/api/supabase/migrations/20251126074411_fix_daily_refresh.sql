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
    v_new_balance NUMERIC(10, 2);
    v_old_expiring NUMERIC(10, 2);
    v_tracking_id UUID;
BEGIN
    v_interval := (p_refresh_interval_hours || ' hours')::INTERVAL;
    
    SELECT last_daily_refresh, expiring_credits
    INTO v_last_refresh, v_old_expiring
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
    
    SELECT EXISTS(
        SELECT 1 FROM daily_refresh_tracking
        WHERE account_id = p_account_id
        AND refresh_date = v_refresh_date
    ) INTO v_already_refreshed;
    
    IF v_already_refreshed THEN
        RAISE NOTICE '[ATOMIC DAILY REFRESH] Already refreshed for % on %', p_account_id, v_refresh_date;
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'already_refreshed_today',
            'duplicate_prevented', true,
            'refresh_date', v_refresh_date
        );
    END IF;
    
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
        RAISE NOTICE '[ATOMIC DAILY REFRESH] Concurrent insert prevented for % on %', p_account_id, v_refresh_date;
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'concurrent_refresh_prevented',
            'duplicate_prevented', true,
            'refresh_date', v_refresh_date
        );
    END IF;
    
    IF v_old_expiring > 0 THEN
        UPDATE credit_accounts
        SET
            expiring_credits = p_credit_amount,
            balance = balance - v_old_expiring + p_credit_amount,
            last_daily_refresh = v_now,
            updated_at = v_now
        WHERE account_id = p_account_id
        RETURNING balance INTO v_new_balance;
        
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
            p_credit_amount - v_old_expiring,
            v_new_balance,
            'daily_grant',
            format('Daily credits reset: $%s → $%s', v_old_expiring, p_credit_amount),
            TRUE,
            v_now + v_interval,
            jsonb_build_object(
                'tier', p_tier,
                'refresh_date', v_refresh_date,
                'old_expiring', v_old_expiring,
                'new_expiring', p_credit_amount,
                'refresh_interval_hours', p_refresh_interval_hours,
                'tracking_id', v_tracking_id
            )
        );
        
        RAISE NOTICE '[ATOMIC DAILY REFRESH] Reset expiring credits from $% to $% for %', 
            v_old_expiring, p_credit_amount, p_account_id;
    ELSE
        UPDATE credit_accounts
        SET
            expiring_credits = expiring_credits + p_credit_amount,
            balance = balance + p_credit_amount,
            last_daily_refresh = v_now,
            updated_at = v_now
        WHERE account_id = p_account_id
        RETURNING balance INTO v_new_balance;
        
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
            p_credit_amount,
            v_new_balance,
            'daily_grant',
            format('Daily credits refresh: $%s', p_credit_amount),
            TRUE,
            v_now + v_interval,
            jsonb_build_object(
                'tier', p_tier,
                'refresh_date', v_refresh_date,
                'refresh_interval_hours', p_refresh_interval_hours,
                'tracking_id', v_tracking_id
            )
        );
        
        RAISE NOTICE '[ATOMIC DAILY REFRESH] Added $% daily credits to % (first refresh or fully consumed)', 
            p_credit_amount, p_account_id;
    END IF;
    
    RETURN jsonb_build_object(
        'success', true,
        'credits_granted', p_credit_amount,
        'new_balance', v_new_balance,
        'refresh_date', v_refresh_date,
        'old_expiring', v_old_expiring,
        'duplicate_prevented', false,
        'tracking_id', v_tracking_id
    );
END;
$$ LANGUAGE plpgsql;

