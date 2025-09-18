-- Transition from Complex to Simple Enterprise Billing System
-- This migration safely transitions from the existing complex enterprise tables
-- to the simplified single-account system while preserving data
BEGIN;

-- =====================================================
-- 1. CREATE NEW SIMPLIFIED TABLES (IF THEY DON'T EXIST)
-- =====================================================

-- Single enterprise billing account for ALL users
CREATE TABLE IF NOT EXISTS public.enterprise_billing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_balance DECIMAL(12, 4) NOT NULL DEFAULT 0 CHECK (credit_balance >= 0),
    total_loaded DECIMAL(12, 4) NOT NULL DEFAULT 0,
    total_used DECIMAL(12, 4) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Per-user monthly limits
CREATE TABLE IF NOT EXISTS public.enterprise_user_limits (
    account_id UUID PRIMARY KEY REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    monthly_limit DECIMAL(10, 2) DEFAULT 100.00 CHECK (monthly_limit >= 0),
    current_month_usage DECIMAL(10, 4) DEFAULT 0 CHECK (current_month_usage >= 0),
    last_reset_at TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Credit load audit log
CREATE TABLE IF NOT EXISTS public.enterprise_credit_loads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    amount DECIMAL(10, 2) NOT NULL,
    description TEXT,
    performed_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Usage tracking
CREATE TABLE IF NOT EXISTS public.enterprise_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    thread_id UUID REFERENCES threads(thread_id) ON DELETE SET NULL,
    message_id UUID REFERENCES messages(message_id) ON DELETE SET NULL,
    cost DECIMAL(10, 6) NOT NULL CHECK (cost > 0),
    model_name VARCHAR(100),
    tokens_used INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 2. MIGRATE DATA FROM OLD TABLES TO NEW
-- =====================================================

-- Migrate enterprise billing accounts (combine all into one)
DO $$
DECLARE
    v_total_balance DECIMAL;
    v_total_loaded DECIMAL;
    v_total_used DECIMAL;
BEGIN
    -- Only migrate if old tables exist and new table is empty
    IF EXISTS (SELECT 1 FROM information_schema.tables 
               WHERE table_schema = 'public' 
               AND table_name = 'enterprise_billing_accounts')
       AND NOT EXISTS (SELECT 1 FROM enterprise_billing 
                      WHERE id = '00000000-0000-0000-0000-000000000000') THEN
        
        -- Sum up all existing enterprise accounts
        SELECT 
            COALESCE(SUM(credit_balance), 0),
            COALESCE(SUM(total_loaded), 0),
            COALESCE(SUM(total_used), 0)
        INTO v_total_balance, v_total_loaded, v_total_used
        FROM enterprise_billing_accounts
        WHERE is_active = TRUE;
        
        -- Create single enterprise account with combined totals
        INSERT INTO enterprise_billing (
            id, 
            credit_balance, 
            total_loaded, 
            total_used
        ) VALUES (
            '00000000-0000-0000-0000-000000000000',
            v_total_balance,
            v_total_loaded,
            v_total_used
        ) ON CONFLICT (id) DO UPDATE SET
            credit_balance = EXCLUDED.credit_balance,
            total_loaded = EXCLUDED.total_loaded,
            total_used = EXCLUDED.total_used;
            
        RAISE NOTICE 'Migrated enterprise accounts. Balance: %, Loaded: %, Used: %', 
                     v_total_balance, v_total_loaded, v_total_used;
    END IF;
END $$;

-- Migrate user limits from enterprise_account_members
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables 
               WHERE table_schema = 'public' 
               AND table_name = 'enterprise_account_members') THEN
        
        -- Migrate all active members to user limits
        INSERT INTO enterprise_user_limits (
            account_id,
            monthly_limit,
            current_month_usage,
            is_active,
            created_at
        )
        SELECT 
            account_id,
            monthly_spend_limit,
            current_month_usage,
            is_active,
            joined_at
        FROM enterprise_account_members
        WHERE is_active = TRUE
        ON CONFLICT (account_id) DO UPDATE SET
            monthly_limit = EXCLUDED.monthly_limit,
            current_month_usage = EXCLUDED.current_month_usage,
            is_active = EXCLUDED.is_active;
            
        RAISE NOTICE 'Migrated % user limits', 
                     (SELECT COUNT(*) FROM enterprise_account_members WHERE is_active = TRUE);
    END IF;
END $$;

-- Migrate credit transactions to load history
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables 
               WHERE table_schema = 'public' 
               AND table_name = 'enterprise_credit_transactions') THEN
        
        INSERT INTO enterprise_credit_loads (
            id,
            amount,
            description,
            performed_by,
            created_at
        )
        SELECT 
            id,
            amount,
            description,
            performed_by,
            created_at
        FROM enterprise_credit_transactions
        WHERE transaction_type = 'load'
        ON CONFLICT (id) DO NOTHING;
        
        RAISE NOTICE 'Migrated % credit load records', 
                     (SELECT COUNT(*) FROM enterprise_credit_transactions WHERE transaction_type = 'load');
    END IF;
END $$;

-- Migrate usage logs
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables 
               WHERE table_schema = 'public' 
               AND table_name = 'enterprise_usage_logs') THEN
        
        INSERT INTO enterprise_usage (
            id,
            account_id,
            thread_id,
            message_id,
            cost,
            model_name,
            tokens_used,
            created_at
        )
        SELECT 
            id,
            account_id,
            thread_id,
            message_id,
            cost,
            model_name,
            tokens_used,
            created_at
        FROM enterprise_usage_logs
        ON CONFLICT (id) DO NOTHING;
        
        RAISE NOTICE 'Migrated % usage log records', 
                     (SELECT COUNT(*) FROM enterprise_usage_logs);
    END IF;
END $$;

-- =====================================================
-- 3. CREATE BACKUP OF OLD TABLES (SAFETY)
-- =====================================================

-- Create backup tables with timestamp
DO $$
DECLARE
    backup_suffix TEXT := TO_CHAR(NOW(), 'YYYYMMDD_HH24MISS');
BEGIN
    -- Backup enterprise_billing_accounts
    IF EXISTS (SELECT 1 FROM information_schema.tables 
               WHERE table_schema = 'public' 
               AND table_name = 'enterprise_billing_accounts') THEN
        EXECUTE format('CREATE TABLE IF NOT EXISTS enterprise_billing_accounts_backup_%s AS TABLE enterprise_billing_accounts', backup_suffix);
        RAISE NOTICE 'Created backup: enterprise_billing_accounts_backup_%', backup_suffix;
    END IF;
    
    -- Backup enterprise_account_members
    IF EXISTS (SELECT 1 FROM information_schema.tables 
               WHERE table_schema = 'public' 
               AND table_name = 'enterprise_account_members') THEN
        EXECUTE format('CREATE TABLE IF NOT EXISTS enterprise_account_members_backup_%s AS TABLE enterprise_account_members', backup_suffix);
        RAISE NOTICE 'Created backup: enterprise_account_members_backup_%', backup_suffix;
    END IF;
    
    -- Backup enterprise_credit_transactions
    IF EXISTS (SELECT 1 FROM information_schema.tables 
               WHERE table_schema = 'public' 
               AND table_name = 'enterprise_credit_transactions') THEN
        EXECUTE format('CREATE TABLE IF NOT EXISTS enterprise_credit_transactions_backup_%s AS TABLE enterprise_credit_transactions', backup_suffix);
        RAISE NOTICE 'Created backup: enterprise_credit_transactions_backup_%', backup_suffix;
    END IF;
    
    -- Backup enterprise_usage_logs
    IF EXISTS (SELECT 1 FROM information_schema.tables 
               WHERE table_schema = 'public' 
               AND table_name = 'enterprise_usage_logs') THEN
        EXECUTE format('CREATE TABLE IF NOT EXISTS enterprise_usage_logs_backup_%s AS TABLE enterprise_usage_logs', backup_suffix);
        RAISE NOTICE 'Created backup: enterprise_usage_logs_backup_%', backup_suffix;
    END IF;
END $$;

-- =====================================================
-- 4. DROP OLD TABLES (AFTER BACKUP)
-- =====================================================

DROP TABLE IF EXISTS public.enterprise_usage_logs CASCADE;
DROP TABLE IF EXISTS public.enterprise_credit_transactions CASCADE;
DROP TABLE IF EXISTS public.enterprise_account_members CASCADE;
DROP TABLE IF EXISTS public.enterprise_billing_accounts CASCADE;

-- =====================================================
-- 5. CREATE INDEXES
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_enterprise_user_limits_account_id ON enterprise_user_limits(account_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_user_limits_active ON enterprise_user_limits(is_active);
CREATE INDEX IF NOT EXISTS idx_enterprise_usage_account_id ON enterprise_usage(account_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_usage_created_at ON enterprise_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enterprise_usage_thread_id ON enterprise_usage(thread_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_credit_loads_created_at ON enterprise_credit_loads(created_at DESC);

-- =====================================================
-- 6. CREATE FUNCTIONS FOR CREDIT MANAGEMENT
-- =====================================================

-- Function to use enterprise credits
CREATE OR REPLACE FUNCTION public.use_enterprise_credits_simple(
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
    v_current_balance DECIMAL;
    v_monthly_limit DECIMAL;
    v_current_usage DECIMAL;
BEGIN
    -- Get user's monthly limit and usage
    SELECT monthly_limit, current_month_usage
    INTO v_monthly_limit, v_current_usage
    FROM enterprise_user_limits
    WHERE account_id = p_account_id AND is_active = TRUE;
    
    -- If no limit set, create default
    IF v_monthly_limit IS NULL THEN
        INSERT INTO enterprise_user_limits (account_id)
        VALUES (p_account_id)
        ON CONFLICT (account_id) DO UPDATE SET is_active = TRUE;
        
        v_monthly_limit := 100.00;
        v_current_usage := 0;
    END IF;
    
    -- Check monthly limit
    IF v_current_usage + p_amount > v_monthly_limit THEN
        RETURN QUERY SELECT FALSE, 0::DECIMAL, 'Monthly spend limit exceeded'::TEXT;
        RETURN;
    END IF;
    
    -- Get enterprise balance
    SELECT credit_balance INTO v_current_balance
    FROM enterprise_billing
    WHERE id = '00000000-0000-0000-0000-000000000000';
    
    -- Check sufficient balance
    IF v_current_balance < p_amount THEN
        RETURN QUERY SELECT FALSE, v_current_balance, 'Insufficient enterprise credits'::TEXT;
        RETURN;
    END IF;
    
    -- Deduct from enterprise balance
    UPDATE enterprise_billing
    SET credit_balance = credit_balance - p_amount,
        total_used = total_used + p_amount,
        updated_at = NOW()
    WHERE id = '00000000-0000-0000-0000-000000000000';
    
    -- Update user's monthly usage
    UPDATE enterprise_user_limits
    SET current_month_usage = current_month_usage + p_amount,
        updated_at = NOW()
    WHERE account_id = p_account_id;
    
    -- Log usage
    INSERT INTO enterprise_usage (
        account_id, thread_id, message_id, cost, model_name, tokens_used
    ) VALUES (
        p_account_id, p_thread_id, p_message_id, p_amount, p_model_name, p_tokens_used
    );
    
    RETURN QUERY SELECT TRUE, (v_current_balance - p_amount), 'Success'::TEXT;
END;
$$;

-- Function to load credits
CREATE OR REPLACE FUNCTION public.load_enterprise_credits(
    p_amount DECIMAL,
    p_description TEXT DEFAULT NULL,
    p_performed_by UUID DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, new_balance DECIMAL)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_new_balance DECIMAL;
BEGIN
    -- Add credits to enterprise account
    UPDATE enterprise_billing
    SET credit_balance = credit_balance + p_amount,
        total_loaded = total_loaded + p_amount,
        updated_at = NOW()
    WHERE id = '00000000-0000-0000-0000-000000000000'
    RETURNING credit_balance INTO v_new_balance;
    
    -- Log transaction
    INSERT INTO enterprise_credit_loads (amount, description, performed_by)
    VALUES (p_amount, p_description, p_performed_by);
    
    RETURN QUERY SELECT TRUE, v_new_balance;
END;
$$;

-- Function to reset monthly usage
-- Drop existing function first to change return type
DROP FUNCTION IF EXISTS public.reset_enterprise_monthly_usage();

CREATE OR REPLACE FUNCTION public.reset_enterprise_monthly_usage()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE enterprise_user_limits
    SET current_month_usage = 0,
        last_reset_at = NOW(),
        updated_at = NOW()
    WHERE is_active = TRUE;
END;
$$;

-- =====================================================
-- 7. ENABLE ROW LEVEL SECURITY
-- =====================================================

ALTER TABLE enterprise_billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_user_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_credit_loads ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_usage ENABLE ROW LEVEL SECURITY;

-- Admins can see everything
-- Drop existing policies first to avoid conflicts
DROP POLICY IF EXISTS "Admins can view enterprise billing" ON enterprise_billing;
DROP POLICY IF EXISTS "Admins can view user limits" ON enterprise_user_limits;
DROP POLICY IF EXISTS "Admins can view credit loads" ON enterprise_credit_loads;
DROP POLICY IF EXISTS "Users can view own usage" ON enterprise_usage;

CREATE POLICY "Admins can view enterprise billing" ON enterprise_billing
    FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "Admins can view user limits" ON enterprise_user_limits
    FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "Admins can view credit loads" ON enterprise_credit_loads
    FOR SELECT TO authenticated USING (TRUE);

-- Users can see their own usage
CREATE POLICY "Users can view own usage" ON enterprise_usage
    FOR SELECT TO authenticated 
    USING (account_id IN (
        SELECT account_id FROM basejump.account_user 
        WHERE user_id = auth.uid()
    ));

-- =====================================================
-- 8. CREATE TRIGGERS FOR UPDATED_AT
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing triggers first to avoid conflicts
DROP TRIGGER IF EXISTS update_enterprise_billing_updated_at ON enterprise_billing;
DROP TRIGGER IF EXISTS update_enterprise_user_limits_updated_at ON enterprise_user_limits;

CREATE TRIGGER update_enterprise_billing_updated_at
    BEFORE UPDATE ON enterprise_billing
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_enterprise_user_limits_updated_at
    BEFORE UPDATE ON enterprise_user_limits
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =====================================================
-- 9. ENSURE DEFAULT RECORD EXISTS
-- =====================================================

-- Insert default enterprise billing record if it doesn't exist
INSERT INTO enterprise_billing (id) 
VALUES ('00000000-0000-0000-0000-000000000000')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- =====================================================
-- POST-MIGRATION VERIFICATION
-- =====================================================
-- Run these queries after migration to verify:
-- SELECT * FROM enterprise_billing;
-- SELECT COUNT(*) FROM enterprise_user_limits;
-- SELECT COUNT(*) FROM enterprise_usage;
-- SELECT COUNT(*) FROM enterprise_credit_loads;
