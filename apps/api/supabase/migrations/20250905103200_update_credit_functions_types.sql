CREATE OR REPLACE FUNCTION add_credits(
    p_user_id UUID,
    p_amount DECIMAL,
    p_description TEXT DEFAULT 'Credit added'
) RETURNS DECIMAL AS $$
DECLARE
    v_new_balance DECIMAL;
BEGIN
    INSERT INTO credit_accounts (user_id, balance, tier)
    VALUES (p_user_id, p_amount, 'free')
    ON CONFLICT (user_id) 
    DO UPDATE SET balance = credit_accounts.balance + p_amount
    RETURNING balance INTO v_new_balance;
    
    INSERT INTO credit_ledger (user_id, amount, balance_after, type, description)
    VALUES (p_user_id, p_amount, v_new_balance, 'admin_grant', p_description);
    
    RETURN v_new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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
        last_grant_date = NOW(),
        tier = p_tier
    WHERE user_id = p_user_id
    RETURNING balance INTO v_new_balance;
    
    IF NOT FOUND THEN
        INSERT INTO credit_accounts (user_id, balance, tier, last_grant_date)
        VALUES (p_user_id, p_amount, p_tier, NOW())
        RETURNING balance INTO v_new_balance;
    END IF;
    
    INSERT INTO credit_ledger (user_id, amount, balance_after, type, description)
    VALUES (p_user_id, p_amount, v_new_balance, 'tier_grant', 'Monthly ' || p_tier || ' tier credit grant');
    
    v_period_start := date_trunc('month', NOW());
    v_period_end := v_period_start + INTERVAL '1 month';
    
    INSERT INTO credit_grants (user_id, amount, tier, period_start, period_end)
    VALUES (p_user_id, p_amount, p_tier, v_period_start, v_period_end);
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER; 