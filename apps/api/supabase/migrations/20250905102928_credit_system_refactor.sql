CREATE TABLE IF NOT EXISTS credit_accounts (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    balance DECIMAL(12, 4) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    lifetime_granted DECIMAL(12, 4) NOT NULL DEFAULT 0,
    lifetime_purchased DECIMAL(12, 4) NOT NULL DEFAULT 0,
    lifetime_used DECIMAL(12, 4) NOT NULL DEFAULT 0,
    last_grant_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    amount DECIMAL(12, 4) NOT NULL,
    balance_after DECIMAL(12, 4) NOT NULL,
    type TEXT NOT NULL CHECK (type IN (
        'tier_grant', 'purchase', 'admin_grant', 'promotional',
        'usage', 'refund', 'adjustment', 'expired'
    )),
    description TEXT,
    reference_id UUID,
    reference_type TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS credit_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tier_price_id TEXT,
    amount DECIMAL(12, 4) NOT NULL CHECK (amount > 0),
    granted_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_credit_ledger_user_id ON credit_ledger(user_id, created_at DESC);
CREATE INDEX idx_credit_ledger_type ON credit_ledger(type);
CREATE INDEX idx_credit_ledger_reference ON credit_ledger(reference_id, reference_type);
CREATE INDEX idx_credit_grants_user_period ON credit_grants(user_id, period_start, period_end);

ALTER TABLE credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own credit account" ON credit_accounts
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role manages credit accounts" ON credit_accounts
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Users can view own ledger" ON credit_ledger
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role manages ledger" ON credit_ledger
    FOR ALL USING (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION deduct_credits(
    p_user_id UUID,
    p_amount DECIMAL,
    p_description TEXT,
    p_reference_id UUID DEFAULT NULL,
    p_reference_type TEXT DEFAULT NULL
) RETURNS TABLE (success BOOLEAN, new_balance DECIMAL, transaction_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_balance DECIMAL;
    v_new_balance DECIMAL;
    v_transaction_id UUID;
BEGIN
    SELECT balance INTO v_balance
    FROM credit_accounts
    WHERE user_id = p_user_id
    FOR UPDATE;
    
    IF v_balance IS NULL OR v_balance < p_amount THEN
        RETURN QUERY SELECT FALSE, COALESCE(v_balance, 0::DECIMAL), NULL::UUID;
        RETURN;
    END IF;
    
    v_new_balance := v_balance - p_amount;
    
    UPDATE credit_accounts
    SET balance = v_new_balance,
        lifetime_used = lifetime_used + p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id;
    
    INSERT INTO credit_ledger (
        user_id, amount, balance_after, type, description,
        reference_id, reference_type
    ) VALUES (
        p_user_id, -p_amount, v_new_balance, 'usage', p_description,
        p_reference_id, p_reference_type
    ) RETURNING id INTO v_transaction_id;
    
    RETURN QUERY SELECT TRUE, v_new_balance, v_transaction_id;
END;
$$;

CREATE OR REPLACE FUNCTION add_credits(
    p_user_id UUID,
    p_amount DECIMAL,
    p_type TEXT,
    p_description TEXT,
    p_created_by UUID DEFAULT NULL
) RETURNS DECIMAL
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_new_balance DECIMAL;
BEGIN
    INSERT INTO credit_accounts (user_id, balance, lifetime_granted)
    VALUES (p_user_id, p_amount, CASE WHEN p_type IN ('tier_grant', 'admin_grant') THEN p_amount ELSE 0 END)
    ON CONFLICT (user_id) DO UPDATE
    SET balance = credit_accounts.balance + p_amount,
        lifetime_granted = credit_accounts.lifetime_granted + 
            CASE WHEN p_type IN ('tier_grant', 'admin_grant') THEN p_amount ELSE 0 END,
        lifetime_purchased = credit_accounts.lifetime_purchased +
            CASE WHEN p_type = 'purchase' THEN p_amount ELSE 0 END,
        updated_at = NOW()
    RETURNING balance INTO v_new_balance;
    
    INSERT INTO credit_ledger (
        user_id, amount, balance_after, type, description, created_by
    ) VALUES (
        p_user_id, p_amount, v_new_balance, p_type, p_description, p_created_by
    );
    
    RETURN v_new_balance;
END;
$$; 