-- Add setup_complete_at column to accounts table.
-- Tracks when the user completed the setup wizard (provider + tool key configuration).
-- NULL means setup has not been completed yet.

ALTER TABLE kortix.accounts
  ADD COLUMN IF NOT EXISTS setup_complete_at timestamp with time zone;
