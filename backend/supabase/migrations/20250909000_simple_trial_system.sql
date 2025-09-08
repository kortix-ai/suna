-- Simple trial system - just the essentials
-- No complex triggers or functions, trials are managed via API

BEGIN;

-- Add trial columns to credit_accounts if they don't exist
ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS trial_status VARCHAR(20) DEFAULT 'none' 
  CHECK (trial_status IN ('none', 'active', 'expired', 'converted'));

ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ;

ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);

-- Simple trial history table for tracking
CREATE TABLE IF NOT EXISTS trial_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    converted_to_paid BOOLEAN DEFAULT FALSE,
    stripe_checkout_session_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Only one trial per account
    CONSTRAINT one_trial_per_account UNIQUE(account_id)
);

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_trial_history_account_id ON trial_history(account_id);
CREATE INDEX IF NOT EXISTS idx_credit_accounts_trial_status ON credit_accounts(trial_status) WHERE trial_status != 'none';

-- Enable RLS
ALTER TABLE trial_history ENABLE ROW LEVEL SECURITY;

-- Simple RLS policy - users can only see their own trial history
CREATE POLICY "Users can view own trial history" ON trial_history
    FOR SELECT USING (auth.uid() = account_id);

-- That's it! No complex functions or triggers
-- Trials are managed via the API endpoints

COMMIT; 