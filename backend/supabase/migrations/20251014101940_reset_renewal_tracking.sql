UPDATE credit_accounts
SET last_renewal_period_start = NULL
WHERE last_renewal_period_start IS NOT NULL;

COMMENT ON COLUMN credit_accounts.last_renewal_period_start IS 'Unix timestamp of the START of the next billing period for which credits have been granted. This is the period_end from the renewal invoice. Only set by invoice.payment_succeeded webhooks for subscription_cycle invoices.';
