CREATE TABLE IF NOT EXISTS admin_actions_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id UUID NOT NULL REFERENCES auth.users(id),
    action_type TEXT NOT NULL,
    target_user_id UUID REFERENCES auth.users(id),
    details JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_admin_actions_admin ON admin_actions_log(admin_user_id, created_at DESC);
CREATE INDEX idx_admin_actions_target ON admin_actions_log(target_user_id, created_at DESC);
CREATE INDEX idx_admin_actions_type ON admin_actions_log(action_type, created_at DESC);

ALTER TABLE admin_actions_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Only admins can view logs" ON admin_actions_log
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM user_roles 
            WHERE user_id = auth.uid() 
            AND role IN ('admin', 'super_admin')
        )
    );

CREATE POLICY "Service role manages logs" ON admin_actions_log
    FOR ALL USING (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION migrate_user_to_credits(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_subscription RECORD;
    v_tier_credits DECIMAL;
    v_already_migrated BOOLEAN;
BEGIN
    SELECT EXISTS(SELECT 1 FROM credit_accounts WHERE user_id = p_user_id) INTO v_already_migrated;
    
    IF v_already_migrated THEN
        RETURN TRUE;
    END IF;
    
    SELECT bs.price_id, bs.current_period_start, bs.current_period_end
    INTO v_subscription
    FROM basejump.billing_subscriptions bs
    WHERE bs.account_id = p_user_id
    AND bs.status = 'active'
    ORDER BY bs.created DESC
    LIMIT 1;
    
    v_tier_credits := CASE 
        WHEN v_subscription.price_id LIKE '%tier_2_20%' THEN 25
        WHEN v_subscription.price_id LIKE '%tier_6_50%' THEN 55
        WHEN v_subscription.price_id LIKE '%tier_12_100%' THEN 105
        WHEN v_subscription.price_id LIKE '%tier_25_200%' THEN 205
        WHEN v_subscription.price_id LIKE '%tier_50_400%' THEN 405
        WHEN v_subscription.price_id LIKE '%tier_125_800%' THEN 805
        WHEN v_subscription.price_id LIKE '%tier_200_1000%' THEN 1005
        ELSE 5
    END;
    
    INSERT INTO credit_accounts (user_id, balance, lifetime_granted)
    VALUES (p_user_id, v_tier_credits, v_tier_credits);
    
    INSERT INTO credit_ledger (
        user_id, amount, balance_after, type, description
    ) VALUES (
        p_user_id, v_tier_credits, v_tier_credits, 'tier_grant', 
        'Initial migration credit grant'
    );
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER; 