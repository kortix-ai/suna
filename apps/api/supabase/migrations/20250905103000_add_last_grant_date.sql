ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS last_grant_date TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_credit_accounts_last_grant ON credit_accounts(last_grant_date);

CREATE OR REPLACE FUNCTION grant_tier_credits(
    p_user_id UUID,
    p_amount DECIMAL,
    p_tier VARCHAR
) RETURNS BOOLEAN AS $$
DECLARE
    v_new_balance DECIMAL;
    v_period_start TIMESTAMPTZ;
    v_period_end TIMESTAMPTZ;
BEGIN
    UPDATE credit_accounts 
    SET balance = balance + p_amount,
        last_grant_date = NOW()
    WHERE user_id = p_user_id
    RETURNING balance INTO v_new_balance;
    
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    
    INSERT INTO credit_ledger (user_id, amount, balance_after, type, description)
    VALUES (p_user_id, p_amount, v_new_balance, 'credit', 'Monthly ' || p_tier || ' tier credit grant');
    
    v_period_start := date_trunc('month', NOW());
    v_period_end := v_period_start + INTERVAL '1 month';
    
    INSERT INTO credit_grants (user_id, amount, tier, period_start, period_end)
    VALUES (p_user_id, p_amount, p_tier, v_period_start, v_period_end);
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER; 