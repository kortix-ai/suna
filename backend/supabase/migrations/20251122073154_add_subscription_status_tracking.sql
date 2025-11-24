BEGIN;

ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS stripe_subscription_status VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_subscription_status 
ON credit_accounts(stripe_subscription_status) 
WHERE stripe_subscription_status IS NOT NULL;

COMMENT ON COLUMN credit_accounts.stripe_subscription_status IS 'Current Stripe subscription status: active, past_due, canceled, incomplete, incomplete_expired, trialing, unpaid';

UPDATE credit_accounts
SET stripe_subscription_status = 'active'
WHERE stripe_subscription_id IS NOT NULL
AND tier NOT IN ('none', 'free')
AND stripe_subscription_status IS NULL;

COMMIT;
