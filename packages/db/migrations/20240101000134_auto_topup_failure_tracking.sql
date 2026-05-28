ALTER TABLE kortix.credit_accounts
  ADD COLUMN IF NOT EXISTS auto_topup_consecutive_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_topup_disabled_reason text;
