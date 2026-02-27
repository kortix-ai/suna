BEGIN;

DROP FUNCTION IF EXISTS refresh_daily_credits(UUID, TEXT, DECIMAL, INTEGER);

CREATE OR REPLACE FUNCTION refresh_daily_credits(
    p_account_id UUID,
    p_tier TEXT,
    p_daily_amount DECIMAL,
    p_refresh_interval_hours NUMERIC DEFAULT 24
)
RETURNS TABLE(
    success BOOLEAN,
    new_daily_balance DECIMAL,
    credits_added DECIMAL,
    last_refresh TIMESTAMPTZ
)
SECURITY DEFINER
AS $$
DECLARE
    v_current_refresh TIMESTAMPTZ;
    v_now TIMESTAMPTZ := NOW();
    v_should_refresh BOOLEAN := FALSE;
    v_old_balance DECIMAL;
    v_credits_added DECIMAL := 0;
    v_interval INTERVAL;
BEGIN
    v_interval := (p_refresh_interval_hours || ' hours')::INTERVAL;
    
    SELECT last_daily_refresh, daily_credits_balance
    INTO v_current_refresh, v_old_balance
    FROM credit_accounts
    WHERE account_id = p_account_id;
    
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 0::DECIMAL, 0::DECIMAL, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    
    IF v_current_refresh IS NULL OR v_now - v_current_refresh > v_interval THEN
        v_should_refresh := TRUE;
    END IF;
    
    IF v_should_refresh THEN
        v_credits_added := p_daily_amount;
        
        UPDATE credit_accounts
        SET 
            daily_credits_balance = p_daily_amount,
            last_daily_refresh = v_now,
            updated_at = v_now
        WHERE account_id = p_account_id;
        
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
            p_daily_amount,
            (SELECT balance FROM credit_accounts WHERE account_id = p_account_id),
            'daily_grant',
            'Daily credits refresh',
            TRUE,
            v_now + v_interval,
            jsonb_build_object(
                'tier', p_tier,
                'refresh_time', v_now,
                'old_daily_balance', v_old_balance,
                'new_daily_balance', p_daily_amount,
                'refresh_interval_hours', p_refresh_interval_hours
            )
        );
        
        RETURN QUERY SELECT TRUE, p_daily_amount, v_credits_added, v_now;
    ELSE
        RETURN QUERY SELECT FALSE, v_old_balance, 0::DECIMAL, v_current_refresh;
    END IF;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION refresh_daily_credits(UUID, TEXT, DECIMAL, NUMERIC) TO authenticated, service_role;

COMMIT;

