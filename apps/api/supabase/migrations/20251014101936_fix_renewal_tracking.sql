UPDATE credit_accounts
SET last_renewal_period_start = NULL
WHERE last_renewal_period_start IS NOT NULL
  AND tier NOT IN ('free', 'none')
  AND last_grant_date IS NOT NULL
  AND DATE(to_timestamp(last_renewal_period_start)) = DATE(last_grant_date AT TIME ZONE 'UTC');

COMMENT ON COLUMN credit_accounts.last_renewal_period_start IS 'Unix timestamp of the last renewal period processed. Used to prevent double-crediting on renewals. Only set by invoice.payment_succeeded webhooks for subscription_cycle invoices, never for upgrades.';
