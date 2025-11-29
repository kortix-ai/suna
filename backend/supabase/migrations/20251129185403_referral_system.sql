CREATE TABLE IF NOT EXISTS referral_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'referral_codes' 
        AND column_name = 'user_id'
    ) THEN
        ALTER TABLE referral_codes RENAME COLUMN user_id TO account_id;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    referred_account_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    referral_code TEXT NOT NULL,
    credits_awarded DECIMAL(12, 4) NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired')) DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'
);

DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'referrals' 
        AND column_name = 'referred_user_id'
    ) THEN
        ALTER TABLE referrals RENAME COLUMN referred_user_id TO referred_account_id;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS referral_stats (
    account_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    total_referrals INTEGER NOT NULL DEFAULT 0,
    successful_referrals INTEGER NOT NULL DEFAULT 0,
    total_credits_earned DECIMAL(12, 4) NOT NULL DEFAULT 0,
    last_referral_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'referral_stats' 
        AND column_name = 'user_id'
    ) THEN
        ALTER TABLE referral_stats RENAME COLUMN user_id TO account_id;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_account_id);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
CREATE INDEX IF NOT EXISTS idx_referral_codes_account ON referral_codes(account_id);
CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_stats ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referral_codes' AND policyname = 'Users can view own referral code') THEN
        CREATE POLICY "Users can view own referral code" ON referral_codes
            FOR SELECT USING (auth.uid() = account_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referral_codes' AND policyname = 'Users can create own referral code') THEN
        CREATE POLICY "Users can create own referral code" ON referral_codes
            FOR INSERT WITH CHECK (auth.uid() = account_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referral_codes' AND policyname = 'Service role manages referral codes') THEN
        CREATE POLICY "Service role manages referral codes" ON referral_codes
            FOR ALL USING (auth.role() = 'service_role');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referrals' AND policyname = 'Users can view own referrals as referrer') THEN
        CREATE POLICY "Users can view own referrals as referrer" ON referrals
            FOR SELECT USING (auth.uid() = referrer_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referrals' AND policyname = 'Users can view own referrals as referred') THEN
        CREATE POLICY "Users can view own referrals as referred" ON referrals
            FOR SELECT USING (auth.uid() = referred_account_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referrals' AND policyname = 'Service role manages referrals') THEN
        CREATE POLICY "Service role manages referrals" ON referrals
            FOR ALL USING (auth.role() = 'service_role');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referral_stats' AND policyname = 'Users can view own referral stats') THEN
        CREATE POLICY "Users can view own referral stats" ON referral_stats
            FOR SELECT USING (auth.uid() = account_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referral_stats' AND policyname = 'Service role manages referral stats') THEN
        CREATE POLICY "Service role manages referral stats" ON referral_stats
            FOR ALL USING (auth.role() = 'service_role');
    END IF;
END $$;

DROP FUNCTION IF EXISTS generate_referral_code(UUID);
DROP FUNCTION IF EXISTS get_or_create_referral_code(UUID);
DROP FUNCTION IF EXISTS validate_referral_code(TEXT);
DROP FUNCTION IF EXISTS process_referral(UUID, UUID, TEXT, DECIMAL);
DROP FUNCTION IF EXISTS get_referral_stats(UUID);
DROP FUNCTION IF EXISTS get_user_referrals(UUID, INTEGER, INTEGER);

CREATE FUNCTION generate_referral_code(
    p_account_id UUID
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_code TEXT;
    v_exists BOOLEAN;
    v_counter INTEGER := 0;
BEGIN
    LOOP
        v_code := substring(md5(random()::text || p_account_id::text || now()::text) from 1 for 8);
        v_code := upper(v_code);
        
        SELECT EXISTS(SELECT 1 FROM referral_codes WHERE code = v_code) INTO v_exists;
        
        IF NOT v_exists THEN
            INSERT INTO referral_codes (account_id, code)
            VALUES (p_account_id, v_code)
            ON CONFLICT (account_id) DO UPDATE
            SET code = v_code, updated_at = NOW()
            RETURNING code INTO v_code;
            
            RETURN v_code;
        END IF;
        
        v_counter := v_counter + 1;
        IF v_counter > 10 THEN
            RAISE EXCEPTION 'Failed to generate unique referral code after 10 attempts';
        END IF;
    END LOOP;
END;
$$;

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
    WHERE account_id = p_account_id;
    
    IF v_code IS NULL THEN
        v_code := generate_referral_code(p_account_id);
    END IF;
    
    RETURN v_code;
END;
$$;

CREATE FUNCTION validate_referral_code(
    p_code TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_account_id UUID;
BEGIN
    SELECT account_id INTO v_account_id
    FROM referral_codes
    WHERE code = upper(p_code);
    
    RETURN v_account_id;
END;
$$;

CREATE FUNCTION process_referral(
    p_referrer_id UUID,
    p_referred_account_id UUID,
    p_referral_code TEXT,
    p_credits_amount DECIMAL DEFAULT 100.00
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_referral_id UUID;
    v_new_balance DECIMAL;
    v_existing_referral UUID;
BEGIN
    SELECT id INTO v_existing_referral
    FROM referrals
    WHERE referred_account_id = p_referred_account_id;
    
    IF v_existing_referral IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'User already referred by someone else',
            'referral_id', v_existing_referral
        );
    END IF;
    
    IF p_referrer_id = p_referred_account_id THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Cannot refer yourself'
        );
    END IF;
    
    INSERT INTO referrals (
        referrer_id, 
        referred_account_id, 
        referral_code, 
        credits_awarded, 
        status,
        completed_at
    )
    VALUES (
        p_referrer_id,
        p_referred_account_id,
        p_referral_code,
        p_credits_amount,
        'completed',
        NOW()
    )
    RETURNING id INTO v_referral_id;
    
    INSERT INTO credit_accounts (account_id, balance, non_expiring_credits, tier)
    VALUES (p_referrer_id, p_credits_amount, p_credits_amount, 'free')
    ON CONFLICT (account_id) 
    DO UPDATE SET 
        balance = credit_accounts.balance + p_credits_amount,
        non_expiring_credits = credit_accounts.non_expiring_credits + p_credits_amount,
        updated_at = NOW()
    RETURNING balance INTO v_new_balance;
    
    INSERT INTO credit_ledger (account_id, amount, balance_after, type, description)
    VALUES (p_referrer_id, p_credits_amount, v_new_balance, 'promotional', format('Referral bonus for user signup (code: %s)', p_referral_code));
    
    INSERT INTO referral_stats (account_id, total_referrals, successful_referrals, total_credits_earned, last_referral_at)
    VALUES (p_referrer_id, 1, 1, p_credits_amount, NOW())
    ON CONFLICT (account_id) DO UPDATE
    SET 
        total_referrals = referral_stats.total_referrals + 1,
        successful_referrals = referral_stats.successful_referrals + 1,
        total_credits_earned = referral_stats.total_credits_earned + p_credits_amount,
        last_referral_at = NOW(),
        updated_at = NOW();
    
    RETURN jsonb_build_object(
        'success', true,
        'referral_id', v_referral_id,
        'credits_awarded', p_credits_amount,
        'new_balance', v_new_balance,
        'message', 'Referral processed successfully'
    );
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

GRANT EXECUTE ON FUNCTION generate_referral_code(UUID) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION get_or_create_referral_code(UUID) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION validate_referral_code(TEXT) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION process_referral(UUID, UUID, TEXT, DECIMAL) TO service_role;
GRANT EXECUTE ON FUNCTION get_referral_stats(UUID) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION get_user_referrals(UUID, INTEGER, INTEGER) TO service_role, authenticated;
