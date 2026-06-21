-- Add auto-topup configuration columns to credit_accounts
-- These allow Pro users to configure automatic credit reloading.

ALTER TABLE kortix.credit_accounts
  ADD COLUMN IF NOT EXISTS auto_topup_enabled       boolean        DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS auto_topup_threshold      numeric(10,2)  DEFAULT 5    NOT NULL,
  ADD COLUMN IF NOT EXISTS auto_topup_amount         numeric(10,2)  DEFAULT 15   NOT NULL,
  ADD COLUMN IF NOT EXISTS auto_topup_last_charged   timestamp with time zone;

-- Constraints:
--   threshold >= 5
--   amount >= 15
--   amount >= 2 * threshold
-- Enforced at application level to keep DB simple.

-- Also add a column to track which sandbox is the "included" one with the Pro plan.
-- Additional sandboxes will have stripe_subscription_item_id set.
ALTER TABLE kortix.sandboxes
  ADD COLUMN IF NOT EXISTS is_included       boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS stripe_subscription_item_id text;
