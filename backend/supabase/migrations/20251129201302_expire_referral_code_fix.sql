DROP FUNCTION IF EXISTS expire_referral_code(UUID);

CREATE FUNCTION expire_referral_code(
    p_account_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_old_code TEXT;
    v_new_code TEXT;
    v_counter INTEGER := 0;
    v_exists BOOLEAN;
BEGIN
    SELECT code INTO v_old_code
    FROM referral_codes
    WHERE account_id = p_account_id;
    
    IF v_old_code IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'No referral code found'
        );
    END IF;
    
    LOOP
        v_new_code := substring(md5(random()::text || p_account_id::text || now()::text || v_counter::text) from 1 for 8);
        v_new_code := upper(v_new_code);
        
        SELECT EXISTS(
            SELECT 1 FROM referral_codes 
            WHERE code = v_new_code
        ) INTO v_exists;
        
        IF NOT v_exists THEN
            UPDATE referral_codes
            SET code = v_new_code,
                updated_at = NOW()
            WHERE account_id = p_account_id;
            
            RETURN jsonb_build_object(
                'success', true,
                'old_code', v_old_code,
                'new_code', v_new_code,
                'message', 'Referral code refreshed successfully'
            );
        END IF;
        
        v_counter := v_counter + 1;
        IF v_counter > 10 THEN
            RAISE EXCEPTION 'Failed to generate unique referral code after 10 attempts';
        END IF;
    END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION expire_referral_code(UUID) TO service_role, authenticated;

