BEGIN;

ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS daily_credits_balance DECIMAL(12, 4) NOT NULL DEFAULT 0 CHECK (daily_credits_balance >= 0);

ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS last_daily_refresh TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_credit_accounts_daily_refresh 
ON credit_accounts(account_id, last_daily_refresh) 
WHERE last_daily_refresh IS NOT NULL;

COMMENT ON COLUMN credit_accounts.daily_credits_balance IS 'Daily credits that expire based on tier-specific refresh interval';
COMMENT ON COLUMN credit_accounts.last_daily_refresh IS 'Timestamp of last daily credits refresh';

CREATE OR REPLACE FUNCTION refresh_daily_credits(
    p_account_id UUID,
    p_tier TEXT,
    p_daily_amount DECIMAL,
    p_refresh_interval_hours INTEGER DEFAULT 24
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
            v_now + INTERVAL '24 hours',
            jsonb_build_object(
                'tier', p_tier,
                'refresh_time', v_now,
                'old_daily_balance', v_old_balance,
                'new_daily_balance', p_daily_amount
            )
        );
        
        RETURN QUERY SELECT TRUE, p_daily_amount, v_credits_added, v_now;
    ELSE
        RETURN QUERY SELECT FALSE, v_old_balance, 0::DECIMAL, v_current_refresh;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION deduct_daily_credits(
    p_account_id UUID,
    p_amount DECIMAL
)
RETURNS TABLE(
    success BOOLEAN,
    deducted_from_daily DECIMAL,
    remaining_daily DECIMAL,
    need_regular_credits DECIMAL
)
SECURITY DEFINER
AS $$
DECLARE
    v_daily_balance DECIMAL;
    v_amount_from_daily DECIMAL;
    v_remaining_amount DECIMAL;
BEGIN
    SELECT daily_credits_balance
    INTO v_daily_balance
    FROM credit_accounts
    WHERE account_id = p_account_id
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 0::DECIMAL, 0::DECIMAL, p_amount;
        RETURN;
    END IF;
    
    IF v_daily_balance >= p_amount THEN
        v_amount_from_daily := p_amount;
        v_remaining_amount := 0;
    ELSE
        v_amount_from_daily := v_daily_balance;
        v_remaining_amount := p_amount - v_daily_balance;
    END IF;
    
    IF v_amount_from_daily > 0 THEN
        UPDATE credit_accounts
        SET 
            daily_credits_balance = daily_credits_balance - v_amount_from_daily,
            updated_at = NOW()
        WHERE account_id = p_account_id;
    END IF;
    
    RETURN QUERY SELECT 
        TRUE,
        v_amount_from_daily,
        v_daily_balance - v_amount_from_daily,
        v_remaining_amount;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_total_available_credits(
    p_account_id UUID
)
RETURNS TABLE(
    total DECIMAL,
    daily_credits DECIMAL,
    expiring_credits DECIMAL,
    non_expiring_credits DECIMAL,
    regular_balance DECIMAL
)
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COALESCE(ca.daily_credits_balance, 0) + COALESCE(ca.balance, 0) as total,
        COALESCE(ca.daily_credits_balance, 0) as daily_credits,
        COALESCE(ca.expiring_credits, 0) as expiring_credits,
        COALESCE(ca.non_expiring_credits, 0) as non_expiring_credits,
        COALESCE(ca.balance, 0) as regular_balance
    FROM credit_accounts ca
    WHERE ca.account_id = p_account_id;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE credit_ledger 
ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) CHECK (source_type IN ('daily', 'regular', 'mixed'));

COMMENT ON COLUMN credit_ledger.source_type IS 'Tracks whether credits were deducted from daily credits, regular credits, or both';

GRANT EXECUTE ON FUNCTION refresh_daily_credits(UUID, TEXT, DECIMAL, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION deduct_daily_credits(UUID, DECIMAL) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_total_available_credits(UUID) TO authenticated, service_role;

COMMIT;
