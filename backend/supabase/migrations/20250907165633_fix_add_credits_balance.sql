DROP FUNCTION IF EXISTS add_credits(UUID, DECIMAL, TEXT, BOOLEAN, TIMESTAMPTZ);
CREATE OR REPLACE FUNCTION add_credits(
    p_user_id UUID,
    p_amount DECIMAL,
    p_description TEXT DEFAULT 'Credit added',
    p_is_expiring BOOLEAN DEFAULT true,
    p_expires_at TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_new_expiring DECIMAL;
    v_new_non_expiring DECIMAL;
    v_new_total DECIMAL;
BEGIN
    IF p_is_expiring THEN
        INSERT INTO credit_accounts (user_id, expiring_credits, non_expiring_credits, balance, tier)
        VALUES (p_user_id, p_amount, 0, p_amount, 'free')
        ON CONFLICT (user_id) 
        DO UPDATE SET 
            expiring_credits = credit_accounts.expiring_credits + p_amount,
            balance = (credit_accounts.expiring_credits + p_amount) + credit_accounts.non_expiring_credits,
            updated_at = NOW()
        RETURNING expiring_credits, non_expiring_credits, balance 
        INTO v_new_expiring, v_new_non_expiring, v_new_total;
    ELSE
        INSERT INTO credit_accounts (user_id, expiring_credits, non_expiring_credits, balance, tier)
        VALUES (p_user_id, 0, p_amount, p_amount, 'free')
        ON CONFLICT (user_id) 
        DO UPDATE SET 
            non_expiring_credits = credit_accounts.non_expiring_credits + p_amount,
            balance = credit_accounts.expiring_credits + (credit_accounts.non_expiring_credits + p_amount),
            updated_at = NOW()
        RETURNING expiring_credits, non_expiring_credits, balance 
        INTO v_new_expiring, v_new_non_expiring, v_new_total;
    END IF;
    
    INSERT INTO credit_ledger (
        user_id, amount, balance_after, type, description, is_expiring, expires_at
    )
    VALUES (
        p_user_id, p_amount, v_new_total, 
        CASE WHEN p_is_expiring THEN 'tier_grant' ELSE 'purchase' END,
        p_description, p_is_expiring, p_expires_at
    );
    
    RETURN jsonb_build_object(
        'expiring_credits', v_new_expiring,
        'non_expiring_credits', v_new_non_expiring,
        'total_balance', v_new_total
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION add_credits(UUID, DECIMAL, TEXT, BOOLEAN, TIMESTAMPTZ) TO service_role; 