-- Enterprise Global Settings
-- Adds configurable global defaults for enterprise mode
BEGIN;

-- =====================================================
-- 1. ENTERPRISE GLOBAL SETTINGS TABLE
-- =====================================================

-- Create table to store enterprise-wide settings and defaults
CREATE TABLE IF NOT EXISTS public.enterprise_global_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    setting_key VARCHAR(255) NOT NULL UNIQUE,
    setting_value JSONB NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id),
    updated_by UUID REFERENCES auth.users(id),
    
    CONSTRAINT enterprise_settings_key_not_empty CHECK (LENGTH(TRIM(setting_key)) > 0)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_enterprise_global_settings_key ON enterprise_global_settings(setting_key);

-- Enable RLS
ALTER TABLE enterprise_global_settings ENABLE ROW LEVEL SECURITY;

-- Only admins can access this table - we'll validate admin access in the application layer
CREATE POLICY "Admin access only" ON enterprise_global_settings
    FOR ALL USING (true);

-- Create trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_enterprise_global_settings_updated_at ON enterprise_global_settings;
CREATE TRIGGER update_enterprise_global_settings_updated_at
    BEFORE UPDATE ON enterprise_global_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 2. INSERT DEFAULT SETTINGS
-- =====================================================

-- Insert default monthly limit for new users
INSERT INTO public.enterprise_global_settings (setting_key, setting_value, description)
VALUES (
    'default_monthly_limit',
    '{"value": 1000.0}',
    'Default monthly spending limit for new enterprise users (in USD)'
) ON CONFLICT (setting_key) DO NOTHING;

-- Insert default tool cost limits (if needed in future)
INSERT INTO public.enterprise_global_settings (setting_key, setting_value, description)
VALUES (
    'default_settings',
    '{
        "monthly_limit": 1000.0,
        "allow_overages": false,
        "notification_threshold": 80.0
    }',
    'Default settings applied to new enterprise users'
) ON CONFLICT (setting_key) DO NOTHING;

-- =====================================================
-- 3. HELPER FUNCTIONS
-- =====================================================

-- Function to get a setting value
CREATE OR REPLACE FUNCTION public.get_enterprise_setting(setting_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    result JSONB;
BEGIN
    SELECT setting_value INTO result
    FROM enterprise_global_settings
    WHERE enterprise_global_settings.setting_key = get_enterprise_setting.setting_key;
    
    RETURN result;
END;
$$;

-- Function to get default monthly limit
CREATE OR REPLACE FUNCTION public.get_default_monthly_limit()
RETURNS DECIMAL
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    result DECIMAL;
    setting_value JSONB;
BEGIN
    -- Get the setting
    SELECT get_enterprise_setting('default_monthly_limit') INTO setting_value;
    
    -- Extract the value, fallback to 1000.0 if not found
    IF setting_value IS NULL THEN
        RETURN 1000.0;
    END IF;
    
    result := (setting_value->>'value')::DECIMAL;
    
    -- Ensure we have a valid value
    IF result IS NULL OR result <= 0 THEN
        RETURN 1000.0;
    END IF;
    
    RETURN result;
END;
$$;

-- =====================================================
-- 4. UPDATE EXISTING FUNCTIONS TO USE DEFAULTS
-- =====================================================

-- Update the enterprise_can_use_tool function to use configurable defaults
CREATE OR REPLACE FUNCTION public.enterprise_can_use_tool(
    p_account_id UUID,
    p_tool_name VARCHAR(255)
)
RETURNS TABLE(can_use BOOLEAN, required_cost DECIMAL, current_balance DECIMAL, user_remaining DECIMAL)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    tool_cost DECIMAL;
    enterprise_balance DECIMAL;
    v_monthly_limit DECIMAL;
    v_current_usage DECIMAL;
    user_remaining DECIMAL;
    default_limit DECIMAL;
BEGIN
    -- Get default limit from settings
    SELECT get_default_monthly_limit() INTO default_limit;
    
    -- Get tool cost from tool_costs table
    SELECT cost_dollars INTO tool_cost
    FROM tool_costs
    WHERE tool_name = p_tool_name AND is_active = true;
    
    -- If no cost found or tool is free, check general enterprise status
    IF tool_cost IS NULL OR tool_cost = 0 THEN
        -- Get user's remaining allowance
        SELECT monthly_limit, current_month_usage
        INTO v_monthly_limit, v_current_usage
        FROM enterprise_user_limits
        WHERE account_id = p_account_id AND is_active = TRUE;
        
        -- Use default if no limit set
        IF v_monthly_limit IS NULL THEN
            v_monthly_limit := default_limit;
            v_current_usage := 0;
        END IF;
        
        user_remaining := v_monthly_limit - v_current_usage;
        
        -- Get enterprise balance
        SELECT credit_balance INTO enterprise_balance
        FROM enterprise_billing
        WHERE id = '00000000-0000-0000-0000-000000000000';
        
        RETURN QUERY SELECT true, COALESCE(tool_cost, 0::DECIMAL), enterprise_balance, user_remaining;
        RETURN;
    END IF;
    
    -- Get user's monthly limit and usage
    SELECT monthly_limit, current_month_usage
    INTO v_monthly_limit, v_current_usage
    FROM enterprise_user_limits
    WHERE account_id = p_account_id AND is_active = TRUE;
    
    -- If no limit set, create default using global setting
    IF v_monthly_limit IS NULL THEN
        INSERT INTO enterprise_user_limits (account_id, monthly_limit)
        VALUES (p_account_id, default_limit)
        ON CONFLICT (account_id) DO UPDATE SET 
            is_active = TRUE,
            monthly_limit = COALESCE(enterprise_user_limits.monthly_limit, default_limit);
        
        v_monthly_limit := default_limit;
        v_current_usage := 0;
    END IF;
    
    user_remaining := v_monthly_limit - v_current_usage;
    
    -- Check if user has remaining monthly allowance for this tool
    IF v_current_usage + tool_cost > v_monthly_limit THEN
        SELECT credit_balance INTO enterprise_balance
        FROM enterprise_billing
        WHERE id = '00000000-0000-0000-0000-000000000000';
        
        RETURN QUERY SELECT FALSE, tool_cost, enterprise_balance, user_remaining;
        RETURN;
    END IF;
    
    -- Get enterprise balance
    SELECT credit_balance INTO enterprise_balance
    FROM enterprise_billing
    WHERE id = '00000000-0000-0000-0000-000000000000';
    
    -- Check if enterprise has enough credit
    IF enterprise_balance < tool_cost THEN
        RETURN QUERY SELECT FALSE, tool_cost, enterprise_balance, user_remaining;
        RETURN;
    END IF;
    
    -- User can use the tool
    RETURN QUERY SELECT TRUE, tool_cost, enterprise_balance, user_remaining;
END;
$$;

COMMIT;
