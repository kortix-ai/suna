CREATE OR REPLACE FUNCTION temp_calculate_credit_split(p_user_id UUID)
RETURNS TABLE(expiring_amount DECIMAL, non_expiring_amount DECIMAL) AS $$
DECLARE
    v_total_purchases DECIMAL := 0;
    v_total_tier_grants DECIMAL := 0;
    v_total_usage DECIMAL := 0;
    v_current_balance DECIMAL;
BEGIN
    SELECT balance INTO v_current_balance
    FROM credit_accounts
    WHERE user_id = p_user_id;
    
    SELECT 
        COALESCE(SUM(CASE 
            WHEN type = 'purchase' AND amount > 0 THEN amount
            WHEN description ILIKE '%purchased%' AND amount > 0 THEN amount
            ELSE 0
        END), 0),
        COALESCE(SUM(CASE 
            WHEN type IN ('tier_grant', 'tier_upgrade', 'subscription_renewal') AND amount > 0 THEN amount
            ELSE 0
        END), 0),
        COALESCE(SUM(CASE 
            WHEN type = 'usage' AND amount < 0 THEN ABS(amount)
            ELSE 0
        END), 0)
    INTO v_total_purchases, v_total_tier_grants, v_total_usage
    FROM credit_ledger
    WHERE user_id = p_user_id;
    
    IF v_total_usage > v_total_tier_grants THEN
        expiring_amount := 0;
        non_expiring_amount := GREATEST(0, v_total_purchases - (v_total_usage - v_total_tier_grants));
    ELSE
        expiring_amount := v_total_tier_grants - v_total_usage;
        non_expiring_amount := v_total_purchases;
    END IF;
    
    IF (expiring_amount + non_expiring_amount) > v_current_balance THEN
        IF (expiring_amount + non_expiring_amount) > 0 THEN
            DECLARE
                v_scale DECIMAL;
            BEGIN
                v_scale := v_current_balance / (expiring_amount + non_expiring_amount);
                expiring_amount := expiring_amount * v_scale;
                non_expiring_amount := non_expiring_amount * v_scale;
            END;
        END IF;
    END IF;
    
    expiring_amount := ROUND(expiring_amount, 2);
    non_expiring_amount := ROUND(non_expiring_amount, 2);
    
    IF (expiring_amount + non_expiring_amount) != v_current_balance THEN
        IF expiring_amount > 0 THEN
            expiring_amount := expiring_amount + (v_current_balance - (expiring_amount + non_expiring_amount));
        ELSE
            non_expiring_amount := non_expiring_amount + (v_current_balance - (expiring_amount + non_expiring_amount));
        END IF;
    END IF;
    
    RETURN QUERY SELECT expiring_amount, non_expiring_amount;
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
SET is_expiring = false
WHERE type = 'purchase' 
   OR description ILIKE '%purchased%';

UPDATE credit_ledger
SET is_expiring = true
WHERE type IN ('tier_grant', 'tier_upgrade', 'subscription_renewal');

DROP FUNCTION IF EXISTS temp_calculate_credit_split(UUID);

DO $$
DECLARE
    v_total_users INTEGER;
    v_users_with_expiring INTEGER;
    v_users_with_non_expiring INTEGER;
    v_total_expiring DECIMAL;
    v_total_non_expiring DECIMAL;
BEGIN
    SELECT 
        COUNT(*),
        COUNT(CASE WHEN expiring_credits > 0 THEN 1 END),
        COUNT(CASE WHEN non_expiring_credits > 0 THEN 1 END),
        COALESCE(SUM(expiring_credits), 0),
        COALESCE(SUM(non_expiring_credits), 0)
    INTO v_total_users, v_users_with_expiring, v_users_with_non_expiring, 
         v_total_expiring, v_total_non_expiring
    FROM credit_accounts;
    
    RAISE NOTICE 'Backfill Summary:';
    RAISE NOTICE '  Total users: %', v_total_users;
    RAISE NOTICE '  Users with expiring credits: %', v_users_with_expiring;
    RAISE NOTICE '  Users with non-expiring credits: %', v_users_with_non_expiring;
    RAISE NOTICE '  Total expiring credits: $%', v_total_expiring;
    RAISE NOTICE '  Total non-expiring credits: $%', v_total_non_expiring;
END;
$$; 