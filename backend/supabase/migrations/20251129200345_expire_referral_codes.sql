ALTER TABLE referral_codes 
ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_referral_codes_expired 
ON referral_codes(expired_at) 
WHERE expired_at IS NOT NULL;

DROP FUNCTION IF EXISTS validate_referral_code(TEXT);
DROP FUNCTION IF EXISTS get_or_create_referral_code(UUID);
DROP FUNCTION IF EXISTS expire_referral_code(UUID);

CREATE FUNCTION validate_referral_code(
    p_code TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_account_id UUID;
    v_expired_at TIMESTAMPTZ;
BEGIN
    SELECT account_id, expired_at INTO v_account_id, v_expired_at
    FROM referral_codes
    WHERE code = upper(p_code);
    
    IF v_account_id IS NULL THEN
        RETURN NULL;
    END IF;
    
    IF v_expired_at IS NOT NULL THEN
        RETURN NULL;
    END IF;
    
    RETURN v_account_id;
END;
$$;

CREATE FUNCTION get_or_create_referral_code(
    p_user_id UUID
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_code TEXT;
BEGIN
    SELECT code INTO v_code
    FROM referral_codes
    WHERE account_id = p_user_id
    AND expired_at IS NULL;
    
    IF v_code IS NULL THEN
        v_code := substring(md5(random()::text || p_user_id::text || now()::text) from 1 for 8);
        v_code := upper(v_code);
        
        INSERT INTO referral_codes (account_id, code)
        VALUES (p_user_id, v_code);
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
    v_code TEXT;
    v_new_code TEXT;
    v_counter INTEGER := 0;
    v_exists BOOLEAN;
BEGIN
    UPDATE referral_codes
    SET expired_at = NOW()
    WHERE account_id = p_account_id
    AND expired_at IS NULL
    RETURNING code INTO v_code;
    
    IF v_code IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'No active referral code found'
        );
    END IF;
    
    LOOP
        v_new_code := substring(md5(random()::text || p_account_id::text || now()::text) from 1 for 8);
        v_new_code := upper(v_new_code);
        
        SELECT EXISTS(SELECT 1 FROM referral_codes WHERE code = v_new_code) INTO v_exists;
        
        IF NOT v_exists THEN
            INSERT INTO referral_codes (account_id, code)
            VALUES (p_account_id, v_new_code);
            
            RETURN jsonb_build_object(
                'success', true,
                'old_code', v_code,
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

GRANT EXECUTE ON FUNCTION validate_referral_code(TEXT) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION get_or_create_referral_code(UUID) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION expire_referral_code(UUID) TO service_role, authenticated;
