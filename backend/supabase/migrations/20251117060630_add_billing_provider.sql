BEGIN;

ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS provider VARCHAR(20) DEFAULT 'stripe' CHECK (provider IN ('stripe', 'revenuecat', 'manual'));

ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS revenuecat_customer_id VARCHAR(255);

ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS revenuecat_subscription_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_provider 
ON credit_accounts(provider);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_revenuecat_customer 
ON credit_accounts(revenuecat_customer_id) 
WHERE revenuecat_customer_id IS NOT NULL;

COMMENT ON COLUMN credit_accounts.provider IS 'Billing provider: stripe, revenuecat, or manual';
COMMENT ON COLUMN credit_accounts.revenuecat_customer_id IS 'RevenueCat customer ID for IAP subscriptions';
COMMENT ON COLUMN credit_accounts.revenuecat_subscription_id IS 'RevenueCat subscription identifier for active subscription';

COMMIT;
