ALTER TABLE credit_accounts
ADD COLUMN IF NOT EXISTS scheduled_tier_change TEXT,
ADD COLUMN IF NOT EXISTS scheduled_tier_change_date TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS scheduled_price_id TEXT;

CREATE INDEX IF NOT EXISTS idx_credit_accounts_scheduled_tier_change 
ON credit_accounts(account_id, scheduled_tier_change) 
WHERE scheduled_tier_change IS NOT NULL;

COMMENT ON COLUMN credit_accounts.scheduled_tier_change IS 'Tier key to downgrade to at end of billing period';
COMMENT ON COLUMN credit_accounts.scheduled_tier_change_date IS 'Date when the tier change will take effect';
COMMENT ON COLUMN credit_accounts.scheduled_price_id IS 'Stripe price ID for the scheduled tier change';
