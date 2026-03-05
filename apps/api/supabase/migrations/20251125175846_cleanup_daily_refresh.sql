BEGIN;

DROP FUNCTION IF EXISTS refresh_daily_credits(UUID, TEXT, DECIMAL, NUMERIC);
DROP FUNCTION IF EXISTS refresh_daily_credits(UUID, TEXT, DECIMAL, INTEGER);
DROP FUNCTION IF EXISTS deduct_daily_credits(UUID, DECIMAL);
DROP FUNCTION IF EXISTS get_total_available_credits(UUID);

ALTER TABLE credit_accounts 
DROP COLUMN IF EXISTS daily_credits_balance;

ALTER TABLE credit_ledger 
DROP COLUMN IF EXISTS source_type;

DROP INDEX IF EXISTS idx_credit_accounts_daily_refresh;

CREATE INDEX IF NOT EXISTS idx_credit_accounts_last_daily_refresh 
ON credit_accounts(account_id, last_daily_refresh) 
WHERE last_daily_refresh IS NOT NULL;

COMMENT ON COLUMN credit_accounts.last_daily_refresh IS 'Timestamp of last daily credits refresh for tiers with daily_credit_config enabled';

COMMIT;
