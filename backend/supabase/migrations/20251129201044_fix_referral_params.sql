DROP FUNCTION IF EXISTS get_or_create_referral_code(UUID);
DROP FUNCTION IF EXISTS get_referral_stats(UUID);
DROP FUNCTION IF EXISTS get_user_referrals(UUID, INTEGER, INTEGER);

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
    AND expired_at IS NULL;
    
    IF v_code IS NULL THEN
        v_code := substring(md5(random()::text || p_account_id::text || now()::text) from 1 for 8);
        v_code := upper(v_code);
        
        INSERT INTO referral_codes (account_id, code)
        VALUES (p_account_id, v_code);
    END IF;
    
    RETURN v_code;
END;
$$;

CREATE FUNCTION get_referral_stats(
    p_account_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_stats JSONB;
    v_code TEXT;
BEGIN
    SELECT code INTO v_code
    FROM referral_codes
    WHERE account_id = p_account_id;
    
    SELECT jsonb_build_object(
        'referral_code', COALESCE(v_code, ''),
        'total_referrals', COALESCE(rs.total_referrals, 0),
        'successful_referrals', COALESCE(rs.successful_referrals, 0),
        'total_credits_earned', COALESCE(rs.total_credits_earned, 0),
        'last_referral_at', rs.last_referral_at
    ) INTO v_stats
    FROM referral_stats rs
    WHERE rs.account_id = p_account_id;
    
    IF v_stats IS NULL THEN
        v_stats := jsonb_build_object(
            'referral_code', COALESCE(v_code, ''),
            'total_referrals', 0,
            'successful_referrals', 0,
            'total_credits_earned', 0,
            'last_referral_at', NULL
        );
    END IF;
    
    RETURN v_stats;
END;
$$;

CREATE FUNCTION get_user_referrals(
    p_account_id UUID,
    p_limit INTEGER DEFAULT 50,
    p_offset INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_referrals JSONB;
BEGIN
    SELECT jsonb_agg(
        jsonb_build_object(
            'id', r.id,
            'referred_account_id', r.referred_account_id,
            'credits_awarded', r.credits_awarded,
            'status', r.status,
            'created_at', r.created_at,
            'completed_at', r.completed_at
        ) ORDER BY r.created_at DESC
    ) INTO v_referrals
    FROM (
        SELECT *
        FROM referrals
        WHERE referrer_id = p_account_id
        ORDER BY created_at DESC
        LIMIT p_limit
        OFFSET p_offset
    ) r;
    
    RETURN COALESCE(v_referrals, '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION get_or_create_referral_code(UUID) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION get_referral_stats(UUID) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION get_user_referrals(UUID, INTEGER, INTEGER) TO service_role, authenticated;

