-- Part 1: Add daily_credits_balance column and index
-- This migration adds the schema changes for daily credits tracking

-- Add daily_credits_balance column
ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS daily_credits_balance NUMERIC(10, 2) NOT NULL DEFAULT 0;

-- Add column comment
COMMENT ON COLUMN credit_accounts.daily_credits_balance IS 'Daily credits that refresh based on tier-specific interval (e.g., every 24h). Consumed FIRST before monthly/extra credits.';

-- Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_credit_accounts_daily_balance 
ON credit_accounts(account_id, daily_credits_balance) 
WHERE daily_credits_balance > 0;

