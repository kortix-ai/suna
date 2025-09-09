-- Enterprise Tool Tracking Integration
-- Adds individual tool cost tracking to enterprise mode
BEGIN;

-- =====================================================
-- 1. EXTEND ENTERPRISE USAGE TABLE
-- =====================================================

-- Add tool-specific fields to enterprise_usage table
ALTER TABLE public.enterprise_usage 
ADD COLUMN IF NOT EXISTS tool_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS tool_cost DECIMAL(10, 6) DEFAULT 0 CHECK (tool_cost >= 0),
ADD COLUMN IF NOT EXISTS usage_type VARCHAR(50) DEFAULT 'token' CHECK (usage_type IN ('token', 'tool'));

-- Create index for tool usage queries
CREATE INDEX IF NOT EXISTS idx_enterprise_usage_tool_name ON enterprise_usage(tool_name) WHERE tool_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_enterprise_usage_type ON enterprise_usage(usage_type);

-- =====================================================
-- 2. ENTERPRISE TOOL FUNCTIONS
-- =====================================================

-- Function to check if user can afford a tool in enterprise mode
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
BEGIN
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
        
        -- Default if no limit set
        IF v_monthly_limit IS NULL THEN
            v_monthly_limit := 1000.00;
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
    
    -- If no limit set, create default
    IF v_monthly_limit IS NULL THEN
        INSERT INTO enterprise_user_limits (account_id)
        VALUES (p_account_id)
        ON CONFLICT (account_id) DO UPDATE SET is_active = TRUE;
        
        v_monthly_limit := 1000.00;
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
    
    -- Check if enterprise has sufficient balance
    IF enterprise_balance < tool_cost THEN
        RETURN QUERY SELECT FALSE, tool_cost, enterprise_balance, user_remaining;
        RETURN;
    END IF;
    
    RETURN QUERY SELECT TRUE, tool_cost, enterprise_balance, user_remaining;
END;
$$;

-- Function to charge for tool usage in enterprise mode
CREATE OR REPLACE FUNCTION public.enterprise_use_tool_credits(
    p_account_id UUID,
    p_tool_name VARCHAR(255),
    p_thread_id UUID DEFAULT NULL,
    p_message_id UUID DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, cost_charged DECIMAL, new_balance DECIMAL, user_remaining DECIMAL)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    tool_cost DECIMAL;
    v_current_balance DECIMAL;
    v_monthly_limit DECIMAL;
    v_current_usage DECIMAL;
    v_new_balance DECIMAL;
    user_remaining DECIMAL;
BEGIN
    -- Get tool cost
    SELECT cost_dollars INTO tool_cost
    FROM tool_costs
    WHERE tool_name = p_tool_name AND is_active = true;
    
    -- If no cost found or free tool, return success
    IF tool_cost IS NULL OR tool_cost = 0 THEN
        -- Still get balances for return values
        SELECT monthly_limit, current_month_usage
        INTO v_monthly_limit, v_current_usage
        FROM enterprise_user_limits
        WHERE account_id = p_account_id AND is_active = TRUE;
        
        IF v_monthly_limit IS NULL THEN
            v_monthly_limit := 1000.00;
            v_current_usage := 0;
        END IF;
        
        user_remaining := v_monthly_limit - v_current_usage;
        
        SELECT credit_balance INTO v_current_balance
        FROM enterprise_billing
        WHERE id = '00000000-0000-0000-0000-000000000000';
        
        RETURN QUERY SELECT true, 0::DECIMAL, v_current_balance, user_remaining;
        RETURN;
    END IF;
    
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
        
        v_monthly_limit := 1000.00;
        v_current_usage := 0;
    END IF;
    
    user_remaining := v_monthly_limit - v_current_usage;
    
    -- Check monthly limit
    IF v_current_usage + tool_cost > v_monthly_limit THEN
        SELECT credit_balance INTO v_current_balance
        FROM enterprise_billing
        WHERE id = '00000000-0000-0000-0000-000000000000';
        
        RETURN QUERY SELECT FALSE, 0::DECIMAL, v_current_balance, user_remaining;
        RETURN;
    END IF;
    
    -- Get enterprise balance
    SELECT credit_balance INTO v_current_balance
    FROM enterprise_billing
    WHERE id = '00000000-0000-0000-0000-000000000000';
    
    -- Check sufficient balance
    IF v_current_balance < tool_cost THEN
        RETURN QUERY SELECT FALSE, 0::DECIMAL, v_current_balance, user_remaining;
        RETURN;
    END IF;
    
    -- Deduct from enterprise balance
    UPDATE enterprise_billing
    SET credit_balance = credit_balance - tool_cost,
        total_used = total_used + tool_cost,
        updated_at = NOW()
    WHERE id = '00000000-0000-0000-0000-000000000000'
    RETURNING credit_balance INTO v_new_balance;
    
    -- Update user's monthly usage
    UPDATE enterprise_user_limits
    SET current_month_usage = current_month_usage + tool_cost,
        updated_at = NOW()
    WHERE account_id = p_account_id;
    
    -- Log tool usage (no model_name for tools, set cost and tool_cost to same value)
    INSERT INTO enterprise_usage (
        account_id, thread_id, message_id, cost, tool_name, tool_cost, usage_type, model_name
    ) VALUES (
        p_account_id, p_thread_id, p_message_id, tool_cost, p_tool_name, tool_cost, 'tool', NULL
    );
    
    user_remaining := user_remaining - tool_cost;
    
    RETURN QUERY SELECT TRUE, tool_cost, v_new_balance, user_remaining;
END;
$$;

-- =====================================================
-- 3. ENTERPRISE TOOL ANALYTICS VIEW
-- =====================================================

-- View for enterprise tool usage analytics
CREATE OR REPLACE VIEW enterprise_tool_usage_analytics AS
SELECT 
    eu.account_id,
    eu.thread_id,
    eu.message_id,
    eu.tool_name,
    eu.tool_cost,
    eu.created_at,
    DATE_TRUNC('day', eu.created_at) as usage_date,
    DATE_TRUNC('hour', eu.created_at) as usage_hour,
    DATE_TRUNC('month', eu.created_at) as usage_month
FROM enterprise_usage eu
WHERE eu.usage_type = 'tool' AND eu.tool_name IS NOT NULL
ORDER BY eu.created_at DESC;

-- =====================================================
-- 4. PERMISSIONS
-- =====================================================

-- Grant permissions for new functions
GRANT EXECUTE ON FUNCTION public.enterprise_can_use_tool TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enterprise_use_tool_credits TO service_role;
GRANT SELECT ON enterprise_tool_usage_analytics TO authenticated, service_role;

-- =====================================================
-- 5. UPDATE EXISTING FUNCTION TO HANDLE MIXED USAGE
-- =====================================================

-- Update the main enterprise credits function to differentiate between token and tool usage
CREATE OR REPLACE FUNCTION public.use_enterprise_credits_simple(
    p_account_id UUID,
    p_amount DECIMAL,
    p_thread_id UUID DEFAULT NULL,
    p_message_id UUID DEFAULT NULL,
    p_model_name VARCHAR DEFAULT NULL,
    p_tokens_used INTEGER DEFAULT NULL,
    p_usage_type VARCHAR DEFAULT 'token'
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
        
        v_monthly_limit := 1000.00;
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
    
    -- Log usage with type differentiation (don't store "unknown" model names)
    INSERT INTO enterprise_usage (
        account_id, thread_id, message_id, cost, model_name, tokens_used, usage_type
    ) VALUES (
        p_account_id, p_thread_id, p_message_id, p_amount, 
        CASE WHEN p_model_name = 'unknown' THEN NULL ELSE p_model_name END, 
        p_tokens_used, p_usage_type
    );
    
    RETURN QUERY SELECT TRUE, (v_current_balance - p_amount), 'Success'::TEXT;
END;
$$;

COMMIT;
