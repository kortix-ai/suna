ALTER TABLE referral_codes 
DROP CONSTRAINT IF EXISTS referral_codes_account_id_key;

CREATE INDEX IF NOT EXISTS idx_referral_codes_account_active 
ON referral_codes(account_id, expired_at) 
WHERE expired_at IS NULL;

DROP FUNCTION IF EXISTS get_or_create_referral_code(UUID);
DROP FUNCTION IF EXISTS expire_referral_code(UUID);

CREATE FUNCTION get_or_create_referral_code(
    p_account_id UUID
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_code TEXT;
BEGIN
    SELECT code INTO v_code
    FROM referral_codes
    WHERE account_id = p_account_id
    AND expired_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1;
    
    IF v_code IS NULL THEN
        v_code := substring(md5(random()::text || p_account_id::text || now()::text) from 1 for 8);
        v_code := upper(v_code);
        
        INSERT INTO referral_codes (account_id, code)
        VALUES (p_account_id, v_code)
        RETURNING code INTO v_code;
    END IF;
    
    RETURN v_code;
END;
$$;

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
    UPDATE referral_codes
    SET expired_at = NOW(),
        updated_at = NOW()
    WHERE account_id = p_account_id
    AND expired_at IS NULL
    RETURNING code INTO v_old_code;
    
    IF v_old_code IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'No active referral code found'
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
            INSERT INTO referral_codes (account_id, code)
            VALUES (p_account_id, v_new_code);
            
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

GRANT EXECUTE ON FUNCTION get_or_create_referral_code(UUID) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION expire_referral_code(UUID) TO service_role, authenticated;

