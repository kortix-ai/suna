-- Billing v2 — per-seat columns on credit_accounts.
-- Existing rows default to billing_model='legacy' so legacy customers are untouched.
-- New signups will set billing_model='per_seat' from the API setup/initialize flow.

ALTER TABLE kortix.credit_accounts
  ADD COLUMN IF NOT EXISTS billing_model                    text          DEFAULT 'legacy' NOT NULL,
  ADD COLUMN IF NOT EXISTS seat_count                       integer       DEFAULT 1        NOT NULL,
  ADD COLUMN IF NOT EXISTS seat_subscription_item_id        text,
  ADD COLUMN IF NOT EXISTS included_compute_per_seat_usd    numeric(10, 4),
  ADD COLUMN IF NOT EXISTS included_yolo_per_seat_usd       numeric(10, 4),
  ADD COLUMN IF NOT EXISTS auto_topup_customized            boolean       DEFAULT false    NOT NULL;

-- Per-seat included balance "buckets" within the wallet. These do not change the
-- aggregate `balance` column — they are sub-accounting so the UI can show
-- "compute remaining" vs "YOLO remaining" vs "topped-up extras".
ALTER TABLE kortix.credit_accounts
  ADD COLUMN IF NOT EXISTS included_compute_balance         numeric(12, 4) DEFAULT '0' NOT NULL,
  ADD COLUMN IF NOT EXISTS included_yolo_balance            numeric(12, 4) DEFAULT '0' NOT NULL;

-- Constraint: billing_model is one of the known values.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kortix_credit_accounts_billing_model_check'
  ) THEN
    ALTER TABLE kortix.credit_accounts
      ADD CONSTRAINT kortix_credit_accounts_billing_model_check
      CHECK (billing_model IN ('legacy', 'per_seat'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_credit_accounts_billing_model
  ON kortix.credit_accounts (billing_model);
