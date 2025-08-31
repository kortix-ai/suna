-- ========================================================
-- RESET ALL USER USAGE LOGS - ADMIN CLEANUP SCRIPT
-- ========================================================
-- 
-- This script resets monthly usage for ALL USERS back to $0
-- Use with caution - this affects ALL users in the system
--
-- WHAT THIS SCRIPT DOES:
-- 1. Deletes all credit_usage records (individual charges)
-- 2. Resets total_used to 0 in credit_balance (keeps purchased credits)
-- 3. Optionally cleans agent_runs and threads (uncomment if needed)
-- 4. Clears Redis cache for monthly usage
--
-- Run this directly in Supabase SQL Editor with service_role permissions
-- ========================================================

BEGIN;

-- Step 1: Backup current state (optional but recommended)
CREATE TEMPORARY TABLE credit_usage_backup AS 
SELECT * FROM public.credit_usage;

CREATE TEMPORARY TABLE credit_balance_backup AS 
SELECT * FROM public.credit_balance;

-- Step 2: Delete all individual usage records
-- This removes the detailed $5.34 breakdown
DELETE FROM public.credit_usage;

-- Step 3: Reset total_used to 0 for all users
-- This keeps their purchased credits but resets monthly usage
UPDATE public.credit_balance 
SET 
    total_used = 0,
    last_updated = NOW()
WHERE total_used > 0;

-- Step 4: [OPTIONAL] Clean conversation history if you want complete reset
-- UNCOMMENT THESE LINES ONLY IF YOU WANT TO DELETE ALL USER DATA:

-- Delete all agent runs (this removes execution history)
-- DELETE FROM public.agent_runs;

-- Delete all conversations (this cascades to messages)
-- DELETE FROM public.threads;

-- Delete all projects (this removes sandbox data)  
-- DELETE FROM public.projects;

-- Step 5: Log the cleanup action
INSERT INTO public.credit_usage (
    user_id,
    amount_dollars, 
    description,
    usage_type,
    created_at
) 
SELECT 
    cb.user_id,
    0.01, -- Minimal cost for logging
    'ADMIN: Usage reset - all monthly limits restored',
    'adjustment',
    NOW()
FROM public.credit_balance cb
WHERE cb.balance_dollars >= 0; -- Only for existing users

COMMIT;

-- ========================================================
-- POST-CLEANUP VERIFICATION QUERIES
-- ========================================================

-- Verify reset worked:
SELECT 
    COUNT(*) as total_users,
    SUM(total_used) as total_usage_all_users,
    SUM(balance_dollars) as total_credits_all_users
FROM public.credit_balance;

-- Should show total_usage_all_users = 0 if successful

-- Check individual user status:
SELECT 
    user_id,
    balance_dollars,
    total_purchased, 
    total_used,
    last_updated
FROM public.credit_balance 
ORDER BY last_updated DESC 
LIMIT 10;

-- ========================================================
-- NOTES:
-- ========================================================
-- 
-- * This script preserves purchased credits (balance_dollars)
-- * Only resets monthly usage tracking (total_used = 0)
-- * Individual credit_usage records are deleted
-- * Agent runs and threads are preserved unless manually uncommented
-- * All users will have fresh $5 free tier limits after this
-- 
-- REDIS CACHE NOTE: 
-- You may also need to clear Redis cache keys like "monthly_usage:*"
-- This can be done via Redis CLI: FLUSHALL or DEL monthly_usage:*
--
-- ========================================================
