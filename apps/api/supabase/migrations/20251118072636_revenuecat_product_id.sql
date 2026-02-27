ALTER TABLE credit_accounts
ADD COLUMN IF NOT EXISTS revenuecat_product_id TEXT;

CREATE INDEX IF NOT EXISTS idx_credit_accounts_revenuecat_product_id 
ON credit_accounts(revenuecat_product_id) 
WHERE revenuecat_product_id IS NOT NULL;

COMMENT ON COLUMN credit_accounts.revenuecat_product_id IS 'RevenueCat product identifier for current subscription';
