ALTER TABLE credit_accounts
ADD COLUMN IF NOT EXISTS revenuecat_cancelled_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS revenuecat_cancel_at_period_end TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS revenuecat_pending_change_product TEXT,
ADD COLUMN IF NOT EXISTS revenuecat_pending_change_date TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_credit_accounts_revenuecat_cancel_at_period_end 
ON credit_accounts(revenuecat_cancel_at_period_end) 
WHERE revenuecat_cancel_at_period_end IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_accounts_revenuecat_pending_change_date 
ON credit_accounts(revenuecat_pending_change_date) 
WHERE revenuecat_pending_change_date IS NOT NULL;
