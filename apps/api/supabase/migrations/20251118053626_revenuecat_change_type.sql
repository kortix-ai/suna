ALTER TABLE credit_accounts
ADD COLUMN IF NOT EXISTS revenuecat_pending_change_type TEXT;

COMMENT ON COLUMN credit_accounts.revenuecat_pending_change_type IS 'Type of pending plan change: upgrade, downgrade, or change';
