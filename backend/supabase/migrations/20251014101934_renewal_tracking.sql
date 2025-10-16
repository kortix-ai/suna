ALTER TABLE credit_accounts
ADD COLUMN IF NOT EXISTS last_renewal_period_start BIGINT;

CREATE INDEX IF NOT EXISTS idx_credit_accounts_last_renewal_period_start 
ON credit_accounts(last_renewal_period_start) 
WHERE last_renewal_period_start IS NOT NULL;

COMMENT ON COLUMN credit_accounts.last_renewal_period_start IS 
'Unix timestamp of the last renewal period start processed by invoice webhook. Used to prevent duplicate credit grants between invoice.payment_succeeded and subscription.updated webhooks.';
