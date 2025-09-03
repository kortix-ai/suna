-- Enterprise Billing System Migration
-- This migration creates all necessary tables for enterprise credit-based billing
BEGIN;

-- =====================================================
-- 1. ENTERPRISE BILLING ACCOUNTS TABLE
-- =====================================================
-- Main table for enterprise billing accounts that pool credits
CREATE TABLE IF NOT EXISTS public.enterprise_billing_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    credit_balance DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (credit_balance >= 0),
    total_loaded DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (total_loaded >= 0),
    total_used DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (total_used >= 0),
    is_active BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id)
);

-- =====================================================
-- 2. ENTERPRISE ACCOUNT MEMBERS TABLE
-- =====================================================
-- Links regular user accounts to enterprise billing accounts
CREATE TABLE IF NOT EXISTS public.enterprise_account_members (
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    enterprise_billing_id UUID NOT NULL REFERENCES enterprise_billing_accounts(id) ON DELETE CASCADE,
    monthly_spend_limit DECIMAL(10, 2) DEFAULT 1000.00 CHECK (monthly_spend_limit >= 0),
    current_month_usage DECIMAL(10, 2) DEFAULT 0 CHECK (current_month_usage >= 0),
    is_active BOOLEAN DEFAULT TRUE,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (account_id),
    
    CONSTRAINT valid_monthly_limit CHECK (monthly_spend_limit > 0)
);

-- =====================================================
-- 3. ENTERPRISE CREDIT TRANSACTIONS TABLE
-- =====================================================
-- Audit log for all credit loading/adjustments
CREATE TABLE IF NOT EXISTS public.enterprise_credit_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_billing_id UUID NOT NULL REFERENCES enterprise_billing_accounts(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    transaction_type VARCHAR(50) NOT NULL CHECK (transaction_type IN ('load', 'refund', 'adjustment')),
    description TEXT,
    performed_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT valid_transaction_amount CHECK (amount != 0)
);

-- =====================================================
-- 4. ENTERPRISE USAGE LOGS TABLE
-- =====================================================
-- Detailed usage tracking for enterprise accounts
CREATE TABLE IF NOT EXISTS public.enterprise_usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_billing_id UUID NOT NULL REFERENCES enterprise_billing_accounts(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    thread_id UUID REFERENCES threads(thread_id) ON DELETE SET NULL,
    message_id UUID REFERENCES messages(message_id) ON DELETE SET NULL,
    cost DECIMAL(10, 4) NOT NULL CHECK (cost > 0),
    usage_type VARCHAR(50) DEFAULT 'token_usage',
    model_name VARCHAR(100),
    tokens_used INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT valid_cost CHECK (cost > 0)
);

-- =====================================================
-- 5. INDEXES FOR PERFORMANCE
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_enterprise_billing_accounts_active ON enterprise_billing_accounts(is_active);
CREATE INDEX IF NOT EXISTS idx_enterprise_billing_accounts_created_at ON enterprise_billing_accounts(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_enterprise_members_billing_id ON enterprise_account_members(enterprise_billing_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_members_account_id ON enterprise_account_members(account_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_members_active ON enterprise_account_members(is_active);

CREATE INDEX IF NOT EXISTS idx_enterprise_transactions_billing_id ON enterprise_credit_transactions(enterprise_billing_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_transactions_created_at ON enterprise_credit_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enterprise_transactions_type ON enterprise_credit_transactions(transaction_type);

CREATE INDEX IF NOT EXISTS idx_enterprise_usage_billing_id ON enterprise_usage_logs(enterprise_billing_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_usage_account_id ON enterprise_usage_logs(account_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_usage_created_at ON enterprise_usage_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enterprise_usage_thread_id ON enterprise_usage_logs(thread_id);

-- =====================================================
-- 6. ROW LEVEL SECURITY POLICIES
-- =====================================================
ALTER TABLE enterprise_billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_account_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_usage_logs ENABLE ROW LEVEL SECURITY;

-- Service role has full access to all enterprise tables
CREATE POLICY "Service role full access enterprise_billing_accounts" ON enterprise_billing_accounts
    FOR ALL USING (auth.role() = 'service_role');
    
CREATE POLICY "Service role full access enterprise_account_members" ON enterprise_account_members
    FOR ALL USING (auth.role() = 'service_role');
    
CREATE POLICY "Service role full access enterprise_credit_transactions" ON enterprise_credit_transactions
    FOR ALL USING (auth.role() = 'service_role');
    
CREATE POLICY "Service role full access enterprise_usage_logs" ON enterprise_usage_logs
    FOR ALL USING (auth.role() = 'service_role');

-- Users can view their own enterprise membership
CREATE POLICY "Users can view their enterprise membership" ON enterprise_account_members
    FOR SELECT USING (
        auth.uid() IN (
            SELECT au.user_id 
            FROM basejump.account_user au 
            WHERE au.account_id = enterprise_account_members.account_id
        )
    );

-- Users can view enterprise usage for their accounts
CREATE POLICY "Users can view their enterprise usage" ON enterprise_usage_logs
    FOR SELECT USING (
        auth.uid() IN (
            SELECT au.user_id 
            FROM basejump.account_user au 
            WHERE au.account_id = enterprise_usage_logs.account_id
        )
    );

-- =====================================================
-- 7. CORE FUNCTIONS
-- =====================================================

-- Function to use enterprise credits (atomic operation)
CREATE OR REPLACE FUNCTION public.use_enterprise_credits(
    p_account_id UUID,
    p_amount DECIMAL,
    p_thread_id UUID DEFAULT NULL,
    p_message_id UUID DEFAULT NULL,
    p_model_name VARCHAR DEFAULT NULL,
    p_tokens_used INTEGER DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, new_balance DECIMAL, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_enterprise_id UUID;
    v_current_balance DECIMAL;
    v_monthly_limit DECIMAL;
    v_current_usage DECIMAL;
    v_new_balance DECIMAL;
BEGIN
    -- Get enterprise billing account and current usage
    SELECT 
        em.enterprise_billing_id, 
        em.monthly_spend_limit, 
        em.current_month_usage,
        eba.credit_balance
    INTO v_enterprise_id, v_monthly_limit, v_current_usage, v_current_balance
    FROM enterprise_account_members em
    JOIN enterprise_billing_accounts eba ON eba.id = em.enterprise_billing_id
    WHERE em.account_id = p_account_id AND em.is_active = TRUE AND eba.is_active = TRUE;
    
    -- Check if account is enterprise
    IF v_enterprise_id IS NULL THEN
        RETURN QUERY SELECT FALSE, 0::DECIMAL, 'Not an enterprise account'::TEXT;
        RETURN;
    END IF;
    
    -- Check monthly limit
    IF v_current_usage + p_amount > v_monthly_limit THEN
        RETURN QUERY SELECT FALSE, v_current_balance, 'Monthly spend limit exceeded'::TEXT;
        RETURN;
    END IF;
    
    -- Check sufficient balance
    IF v_current_balance < p_amount THEN
        RETURN QUERY SELECT FALSE, v_current_balance, 'Insufficient enterprise credits'::TEXT;
        RETURN;
    END IF;
    
    -- Calculate new balance
    v_new_balance := v_current_balance - p_amount;
    
    -- Deduct credits (atomic update)
    UPDATE enterprise_billing_accounts
    SET 
        credit_balance = v_new_balance,
        total_used = total_used + p_amount,
        updated_at = NOW()
    WHERE id = v_enterprise_id;
    
    -- Update user's monthly usage
    UPDATE enterprise_account_members
    SET 
        current_month_usage = current_month_usage + p_amount,
        updated_at = NOW()
    WHERE account_id = p_account_id;
    
    -- Log usage
    INSERT INTO enterprise_usage_logs (
        enterprise_billing_id, account_id, thread_id, message_id, 
        cost, model_name, tokens_used
    ) VALUES (
        v_enterprise_id, p_account_id, p_thread_id, p_message_id, 
        p_amount, p_model_name, p_tokens_used
    );
    
    RETURN QUERY SELECT TRUE, v_new_balance, 'Success'::TEXT;
END;
$$;

-- Function to load credits into enterprise account
CREATE OR REPLACE FUNCTION public.load_enterprise_credits(
    p_enterprise_id UUID,
    p_amount DECIMAL,
    p_description TEXT DEFAULT NULL,
    p_performed_by UUID DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, new_balance DECIMAL, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_new_balance DECIMAL;
BEGIN
    -- Validate amount
    IF p_amount <= 0 THEN
        RETURN QUERY SELECT FALSE, 0::DECIMAL, 'Amount must be positive'::TEXT;
        RETURN;
    END IF;
    
    -- Update enterprise account balance
    UPDATE enterprise_billing_accounts
    SET 
        credit_balance = credit_balance + p_amount,
        total_loaded = total_loaded + p_amount,
        updated_at = NOW()
    WHERE id = p_enterprise_id AND is_active = TRUE
    RETURNING credit_balance INTO v_new_balance;
    
    -- Check if update was successful
    IF v_new_balance IS NULL THEN
        RETURN QUERY SELECT FALSE, 0::DECIMAL, 'Enterprise account not found or inactive'::TEXT;
        RETURN;
    END IF;
    
    -- Log transaction
    INSERT INTO enterprise_credit_transactions (
        enterprise_billing_id, amount, transaction_type, description, performed_by
    ) VALUES (
        p_enterprise_id, p_amount, 'load', 
        COALESCE(p_description, 'Manual credit load'), p_performed_by
    );
    
    RETURN QUERY SELECT TRUE, v_new_balance, 'Credits loaded successfully'::TEXT;
END;
$$;

-- Function to reset monthly usage (called monthly via cron)
CREATE OR REPLACE FUNCTION public.reset_enterprise_monthly_usage()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_reset_count INTEGER;
BEGIN
    -- Reset monthly usage for all active enterprise members
    UPDATE enterprise_account_members
    SET 
        current_month_usage = 0,
        updated_at = NOW()
    WHERE is_active = TRUE;
    
    GET DIAGNOSTICS v_reset_count = ROW_COUNT;
    
    RETURN v_reset_count;
END;
$$;

-- Function to get enterprise billing status
CREATE OR REPLACE FUNCTION public.get_enterprise_billing_status(p_account_id UUID)
RETURNS TABLE(
    is_enterprise BOOLEAN,
    enterprise_id UUID,
    enterprise_name TEXT,
    credit_balance DECIMAL,
    monthly_limit DECIMAL,
    current_usage DECIMAL,
    remaining_monthly DECIMAL,
    is_active BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        TRUE as is_enterprise,
        em.enterprise_billing_id as enterprise_id,
        eba.name as enterprise_name,
        eba.credit_balance,
        em.monthly_spend_limit as monthly_limit,
        em.current_month_usage as current_usage,
        (em.monthly_spend_limit - em.current_month_usage) as remaining_monthly,
        (em.is_active AND eba.is_active) as is_active
    FROM enterprise_account_members em
    JOIN enterprise_billing_accounts eba ON eba.id = em.enterprise_billing_id
    WHERE em.account_id = p_account_id;
    
    -- If no results, return non-enterprise status
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, NULL::DECIMAL, NULL::DECIMAL, NULL::DECIMAL, NULL::DECIMAL, FALSE;
    END IF;
END;
$$;

-- =====================================================
-- 8. UPDATED_AT TRIGGERS
-- =====================================================
CREATE TRIGGER enterprise_billing_accounts_updated_at
    BEFORE UPDATE ON enterprise_billing_accounts
    FOR EACH ROW EXECUTE FUNCTION basejump.trigger_set_timestamps();

CREATE TRIGGER enterprise_account_members_updated_at
    BEFORE UPDATE ON enterprise_account_members
    FOR EACH ROW EXECUTE FUNCTION basejump.trigger_set_timestamps();

-- =====================================================
-- 9. GRANT PERMISSIONS
-- =====================================================
GRANT SELECT, INSERT, UPDATE ON enterprise_billing_accounts TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON enterprise_account_members TO authenticated, service_role;
GRANT SELECT, INSERT ON enterprise_credit_transactions TO authenticated, service_role;
GRANT SELECT, INSERT ON enterprise_usage_logs TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.use_enterprise_credits TO service_role;
GRANT EXECUTE ON FUNCTION public.load_enterprise_credits TO service_role;
GRANT EXECUTE ON FUNCTION public.reset_enterprise_monthly_usage TO service_role;
GRANT EXECUTE ON FUNCTION public.get_enterprise_billing_status TO authenticated, service_role;

COMMIT;
