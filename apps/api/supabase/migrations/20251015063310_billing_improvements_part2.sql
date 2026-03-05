BEGIN;

CREATE TABLE IF NOT EXISTS credit_purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    amount_dollars DECIMAL(10, 2) NOT NULL,
    stripe_payment_intent_id VARCHAR(255) UNIQUE,
    stripe_session_id VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'pending' 
        CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
    error_message TEXT,
    reconciled_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}',
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_purchases_status ON credit_purchases(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_purchases_account ON credit_purchases(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    category VARCHAR(50) NOT NULL,
    action VARCHAR(255) NOT NULL,
    details JSONB DEFAULT '{}',
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_account ON audit_log(account_id, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_category ON audit_log(category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_recent ON audit_log(created_at DESC);

GRANT SELECT ON billing_health_check TO service_role;
GRANT ALL ON credit_purchases TO service_role;
GRANT ALL ON audit_log TO service_role;

ALTER TABLE credit_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own credit purchases" ON credit_purchases
    FOR SELECT USING (auth.uid() = account_id);

CREATE POLICY "Service role manages credit purchases" ON credit_purchases
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Users can view own audit log" ON audit_log
    FOR SELECT USING (auth.uid() = account_id);

CREATE POLICY "Service role manages audit log" ON audit_log
    FOR ALL USING (auth.role() = 'service_role');

COMMIT;
