CREATE OR REPLACE FUNCTION temp_calculate_credit_split(p_user_id UUID)
RETURNS TABLE(
    expiring_amount DECIMAL,
    non_expiring_amount DECIMAL
) AS $$
DECLARE
    v_current_balance DECIMAL;
    v_total_purchases DECIMAL;
    v_total_tier_grants DECIMAL;
    v_total_usage DECIMAL;
    v_net_purchases DECIMAL;
    v_net_tier_grants DECIMAL;
BEGIN
    SELECT COALESCE(balance, 0) INTO v_current_balance
    FROM credit_accounts
    WHERE user_id = p_user_id;
    
    SELECT COALESCE(SUM(amount), 0) INTO v_total_purchases
    FROM credit_ledger
    WHERE user_id = p_user_id
    AND type = 'purchase'
    AND amount > 0;
    
    SELECT COALESCE(SUM(amount), 0) INTO v_total_tier_grants
    FROM credit_ledger
    WHERE user_id = p_user_id
    AND type IN ('tier_grant', 'tier_upgrade')
    AND amount > 0;
    
    SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_total_usage
    FROM credit_ledger
    WHERE user_id = p_user_id
    AND type = 'usage'
    AND amount < 0;
    
    IF v_total_usage > v_total_tier_grants THEN
        v_net_tier_grants := 0;
        v_net_purchases := v_total_purchases - (v_total_usage - v_total_tier_grants);
    ELSE
        v_net_tier_grants := v_total_tier_grants - v_total_usage;
        v_net_purchases := v_total_purchases;
    END IF;
    
    v_net_purchases := GREATEST(0, LEAST(v_net_purchases, v_current_balance));
    v_net_tier_grants := GREATEST(0, LEAST(v_net_tier_grants, v_current_balance - v_net_purchases));
    
    IF (v_net_purchases + v_net_tier_grants) != v_current_balance THEN
        IF v_net_purchases > v_current_balance THEN
            v_net_purchases := v_current_balance;
            v_net_tier_grants := 0;
        ELSE
            v_net_tier_grants := v_current_balance - v_net_purchases;
        END IF;
    END IF;
    
    RETURN QUERY SELECT v_net_tier_grants, v_net_purchases;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    r RECORD;
    v_expiring DECIMAL;
    v_non_expiring DECIMAL;
    v_updated_count INTEGER := 0;
BEGIN
    FOR r IN 
        SELECT user_id, balance, tier
        FROM credit_accounts
        WHERE balance > 0
    LOOP
        SELECT expiring_amount, non_expiring_amount
        INTO v_expiring, v_non_expiring
        FROM temp_calculate_credit_split(r.user_id);
        
        UPDATE credit_accounts
        SET 
            expiring_credits = v_expiring,
            non_expiring_credits = v_non_expiring
        WHERE user_id = r.user_id;
        
        v_updated_count := v_updated_count + 1;
    END LOOP;
    
    RAISE NOTICE 'Migration completed. Updated % users', v_updated_count;
END;
$$;

UPDATE credit_ledger
SET is_expiring = CASE 
    WHEN type IN ('tier_grant', 'tier_upgrade') THEN true
    WHEN type = 'purchase' THEN false
    ELSE true
END
WHERE is_expiring IS NULL;

UPDATE credit_ledger
SET expires_at = date_trunc('month', NOW()) + INTERVAL '1 month'
WHERE type IN ('tier_grant', 'tier_upgrade')
AND expires_at IS NULL
AND created_at >= date_trunc('month', NOW());

DROP FUNCTION IF EXISTS temp_calculate_credit_split(UUID);

CREATE OR REPLACE VIEW credit_migration_summary AS
SELECT 
    COUNT(*) as total_users,
    SUM(balance) as total_balance,
    SUM(expiring_credits) as total_expiring,
    SUM(non_expiring_credits) as total_non_expiring,
    COUNT(CASE WHEN expiring_credits > 0 THEN 1 END) as users_with_expiring,
    COUNT(CASE WHEN non_expiring_credits > 0 THEN 1 END) as users_with_non_expiring,
    COUNT(CASE WHEN ABS(balance - (expiring_credits + non_expiring_credits)) > 0.01 THEN 1 END) as users_with_mismatch
FROM credit_accounts;

GRANT SELECT ON credit_migration_summary TO authenticated; 