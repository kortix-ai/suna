-- Add setup_wizard_step column to accounts table.
-- Tracks the current setup wizard step (0 = not started, 1 = account created,
-- 2 = provider setup, 3 = tool keys). Replaces the old sessionStorage-based
-- approach so the wizard step survives across login/logout cycles.
-- 0 means setup has not been started; once setup_complete_at is set, this
-- column is ignored.

ALTER TABLE kortix.accounts
  ADD COLUMN IF NOT EXISTS setup_wizard_step integer NOT NULL DEFAULT 0;
