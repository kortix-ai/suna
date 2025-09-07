-- Migration: Remove redundant billing data sources
-- ================================================
-- This migration removes unused tables to simplify the billing architecture:
-- 1. credit_grants - Not used in production
-- 2. billing_subscriptions - Replaced by credit_accounts.stripe_subscription_id
--
-- IMPORTANT: Run this migration AFTER verifying all users have credit_accounts entries

BEGIN;

-- Drop credit_grants table (unused)
DROP TABLE IF EXISTS credit_grants CASCADE;

-- Note: We're NOT dropping billing_subscriptions yet for safety
-- Uncomment the following line after thoroughly testing the new system:
-- DROP TABLE IF EXISTS basejump.billing_subscriptions CASCADE;

-- Add comment to billing_subscriptions to mark it as deprecated
COMMENT ON TABLE basejump.billing_subscriptions IS 'DEPRECATED - Use credit_accounts.stripe_subscription_id instead. Will be removed in future migration.';

-- Ensure all necessary indexes exist on credit_accounts
CREATE INDEX IF NOT EXISTS idx_credit_accounts_user_id ON credit_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_accounts_tier ON credit_accounts(tier);
CREATE INDEX IF NOT EXISTS idx_credit_accounts_stripe_subscription_id ON credit_accounts(stripe_subscription_id);

-- Add missing columns to credit_accounts if they don't exist
DO $$
BEGIN
    -- Check if stripe_subscription_id column exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'credit_accounts' 
        AND column_name = 'stripe_subscription_id'
    ) THEN
        ALTER TABLE credit_accounts 
        ADD COLUMN stripe_subscription_id TEXT;
    END IF;

    -- Check if billing_cycle_anchor column exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'credit_accounts' 
        AND column_name = 'billing_cycle_anchor'
    ) THEN
        ALTER TABLE credit_accounts 
        ADD COLUMN billing_cycle_anchor TIMESTAMPTZ;
    END IF;

    -- Check if next_credit_grant column exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'credit_accounts' 
        AND column_name = 'next_credit_grant'
    ) THEN
        ALTER TABLE credit_accounts 
        ADD COLUMN next_credit_grant TIMESTAMPTZ;
    END IF;

    -- Check if last_grant_date column exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'credit_accounts' 
        AND column_name = 'last_grant_date'
    ) THEN
        ALTER TABLE credit_accounts 
        ADD COLUMN last_grant_date TIMESTAMPTZ;
    END IF;
END $$;

COMMIT; 