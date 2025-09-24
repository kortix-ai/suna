-- Migration to create credit_accounts table for backward compatibility
-- This creates a table structure that matches what the billing system expects

BEGIN;

-- Create credit_accounts table to match the expected schema
CREATE TABLE IF NOT EXISTS public.credit_accounts (
    account_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    balance DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    expiring_credits DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (expiring_credits >= 0),
    non_expiring_credits DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (non_expiring_credits >= 0),
    tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'starter', 'pro', 'enterprise')),
    next_credit_grant TIMESTAMPTZ,
    trial_status TEXT DEFAULT 'none' CHECK (trial_status IN ('none', 'active', 'expired', 'cancelled')),
    trial_ends_at TIMESTAMPTZ,
    trial_started_at TIMESTAMPTZ,
    billing_cycle_anchor TIMESTAMPTZ,
    stripe_subscription_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_credit_accounts_account_id ON public.credit_accounts(account_id);
CREATE INDEX IF NOT EXISTS idx_credit_accounts_tier ON public.credit_accounts(tier);
CREATE INDEX IF NOT EXISTS idx_credit_accounts_trial_status ON public.credit_accounts(trial_status);
CREATE INDEX IF NOT EXISTS idx_credit_accounts_stripe_subscription_id ON public.credit_accounts(stripe_subscription_id);

-- Enable RLS
ALTER TABLE public.credit_accounts ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
CREATE POLICY "Users can view their own credit account" ON public.credit_accounts
    FOR SELECT USING (auth.uid() = account_id);

CREATE POLICY "Users can update their own credit account" ON public.credit_accounts
    FOR UPDATE USING (auth.uid() = account_id);

CREATE POLICY "Service role can manage all credit accounts" ON public.credit_accounts
    FOR ALL USING (auth.role() = 'service_role');

-- Create trigger for updated_at
CREATE OR REPLACE FUNCTION update_credit_accounts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_credit_accounts_updated_at ON public.credit_accounts;
CREATE TRIGGER update_credit_accounts_updated_at
    BEFORE UPDATE ON public.credit_accounts
    FOR EACH ROW EXECUTE FUNCTION update_credit_accounts_updated_at();

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.credit_accounts TO authenticated;
GRANT ALL ON TABLE public.credit_accounts TO service_role;

COMMIT;
