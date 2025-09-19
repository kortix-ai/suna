ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS expiring_credits DECIMAL(12, 4) NOT NULL DEFAULT 0 CHECK (expiring_credits >= 0),
ADD COLUMN IF NOT EXISTS non_expiring_credits DECIMAL(12, 4) NOT NULL DEFAULT 0 CHECK (non_expiring_credits >= 0);

ALTER TABLE credit_ledger
ADD COLUMN IF NOT EXISTS is_expiring BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_credit_ledger_expiry ON credit_ledger(user_id, is_expiring, expires_at);

CREATE OR REPLACE VIEW credit_breakdown AS
SELECT 
    ca.user_id,
    ca.tier,
    ca.expiring_credits,
    ca.non_expiring_credits,
    ca.balance as total_balance,
    ca.expiring_credits + ca.non_expiring_credits as calculated_total,
    ca.updated_at,
    ca.next_credit_grant,
    CASE 
        WHEN ca.expiring_credits > 0 AND ca.non_expiring_credits > 0 THEN 'mixed'
        WHEN ca.expiring_credits > 0 THEN 'expiring_only'
        WHEN ca.non_expiring_credits > 0 THEN 'non_expiring_only'
        ELSE 'no_credits'
    END as credit_type
FROM credit_accounts ca;

GRANT SELECT ON credit_breakdown TO authenticated;

COMMENT ON COLUMN credit_accounts.expiring_credits IS 'Credits from subscription plans that expire at billing cycle end';
COMMENT ON COLUMN credit_accounts.non_expiring_credits IS 'Credits from topup purchases that never expire';
COMMENT ON COLUMN credit_ledger.is_expiring IS 'Whether this credit transaction involves expiring credits';
COMMENT ON COLUMN credit_ledger.expires_at IS 'When these credits expire (NULL for non-expiring)'; 