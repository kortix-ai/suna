ALTER TABLE credit_purchases 
ADD COLUMN IF NOT EXISTS provider VARCHAR(50) DEFAULT 'stripe' 
CHECK (provider IN ('stripe', 'revenuecat'));

ALTER TABLE credit_purchases
ADD COLUMN IF NOT EXISTS revenuecat_transaction_id VARCHAR(255) UNIQUE,
ADD COLUMN IF NOT EXISTS revenuecat_product_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_credit_purchases_provider ON credit_purchases(provider, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_credit_purchases_revenuecat_transaction ON credit_purchases(revenuecat_transaction_id);

COMMENT ON COLUMN credit_purchases.provider IS 'Payment provider: stripe or revenuecat';
COMMENT ON COLUMN credit_purchases.revenuecat_transaction_id IS 'RevenueCat transaction ID for one-time purchases';
COMMENT ON COLUMN credit_purchases.revenuecat_product_id IS 'RevenueCat product identifier';
