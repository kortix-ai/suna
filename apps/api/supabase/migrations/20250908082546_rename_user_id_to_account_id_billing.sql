ALTER TABLE credit_accounts RENAME COLUMN user_id TO account_id;

ALTER TABLE credit_ledger RENAME COLUMN user_id TO account_id;

ALTER TABLE credit_purchases RENAME COLUMN user_id TO account_id;

ALTER TABLE credit_balance RENAME COLUMN user_id TO account_id;

ALTER TABLE credit_usage RENAME COLUMN user_id TO account_id;

DROP INDEX IF EXISTS idx_credit_ledger_user_id;
CREATE INDEX IF NOT EXISTS idx_credit_ledger_account_id ON credit_ledger(account_id, created_at DESC);

DROP INDEX IF EXISTS idx_credit_purchases_user_id;
CREATE INDEX IF NOT EXISTS idx_credit_purchases_account_id ON credit_purchases(account_id);

DROP INDEX IF EXISTS idx_credit_accounts_user_id;
CREATE INDEX IF NOT EXISTS idx_credit_accounts_account_id ON credit_accounts(account_id);

DROP INDEX IF EXISTS idx_credit_balance_user_id;
CREATE INDEX IF NOT EXISTS idx_credit_balance_account_id ON credit_balance(account_id);

DROP INDEX IF EXISTS idx_credit_usage_user_id;
CREATE INDEX IF NOT EXISTS idx_credit_usage_account_id ON credit_usage(account_id); 