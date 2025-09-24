-- Migration to add admin and owner tiers to credit_accounts table
-- This allows admin and owner tiers to be assigned to accounts

BEGIN;

-- Drop the existing tier check constraint
ALTER TABLE public.credit_accounts 
DROP CONSTRAINT IF EXISTS credit_accounts_tier_check;

-- Add the new tier check constraint that includes admin and owner tiers
ALTER TABLE public.credit_accounts 
ADD CONSTRAINT credit_accounts_tier_check 
CHECK (tier IN ('free', 'starter', 'pro', 'enterprise', 'admin', 'owner'));

COMMIT;
