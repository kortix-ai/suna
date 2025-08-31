-- ========================================================
-- RESET SINGLE USER USAGE - ADMIN CLEANUP SCRIPT  
-- ========================================================
--
-- This script resets monthly usage for a SPECIFIC USER back to $0
-- Replace 'YOUR_USER_ID_HERE' with the actual user UUID
--
-- USAGE: Run in Supabase SQL Editor with service_role permissions
-- ========================================================

-- 🔧 CONFIGURATION - CHANGE THIS USER ID:
-- Replace with actual user UUID from auth.users table
\set user_to_reset '''YOUR_USER_ID_HERE'''

BEGIN;

-- Step 1: Verify user exists
DO $$
DECLARE 
    user_exists boolean;
    current_usage decimal;
    user_email text;
BEGIN
    -- Check if user exists and get their info
    SELECT EXISTS (
        SELECT 1 FROM auth.users 
        WHERE id = :'user_to_reset'::uuid
    ), 
    COALESCE(cb.total_used, 0),
    u.email
    INTO user_exists, current_usage, user_email
    FROM auth.users u
    LEFT JOIN public.credit_balance cb ON u.id = cb.user_id  
    WHERE u.id = :'user_to_reset'::uuid;
    
    IF NOT user_exists THEN
        RAISE EXCEPTION 'User ID % does not exist', :'user_to_reset';
    END IF;
    
    RAISE NOTICE 'Found user: % with current usage: $%', user_email, current_usage;
END $$;

-- Step 2: Delete individual usage records for this user
DELETE FROM public.credit_usage 
WHERE user_id = :'user_to_reset'::uuid;

-- Get count of deleted records
SELECT 'Deleted ' || ROW_COUNT() || ' usage records' as cleanup_step;

-- Step 3: Reset monthly usage for this user  
UPDATE public.credit_balance 
SET 
    total_used = 0,
    last_updated = NOW()
WHERE user_id = :'user_to_reset'::uuid;

-- Step 4: [OPTIONAL] Delete user's conversation history
-- UNCOMMENT IF YOU WANT TO DELETE ALL USER'S CONVERSATIONS:

-- Get account_id for this user
-- DELETE FROM public.threads 
-- WHERE account_id = (
--     SELECT account_id FROM basejump.accounts 
--     WHERE primary_owner_user_id = :'user_to_reset'::uuid
-- );

-- Step 5: Log the reset action
INSERT INTO public.credit_usage (
    user_id,
    amount_dollars,
    description, 
    usage_type,
    created_at
) VALUES (
    :'user_to_reset'::uuid,
    0.01,
    'ADMIN: Individual user usage reset',
    'adjustment', 
    NOW()
);

COMMIT;

-- ========================================================
-- VERIFICATION
-- ========================================================

-- Check final status
SELECT 
    u.email,
    cb.balance_dollars,
    cb.total_purchased,
    cb.total_used,
    cb.last_updated
FROM auth.users u
LEFT JOIN public.credit_balance cb ON u.id = cb.user_id
WHERE u.id = :'user_to_reset'::uuid;

-- ========================================================
-- NOTES:
-- ========================================================
--
-- BEFORE RUNNING:
-- 1. Replace 'YOUR_USER_ID_HERE' with actual user UUID 
-- 2. Run: SELECT id, email FROM auth.users; to find user ID
--
-- WHAT THIS DOES:
-- ✅ Preserves purchased credits (balance_dollars) 
-- ✅ Resets monthly usage to $0 (total_used = 0)
-- ✅ Deletes detailed usage logs (credit_usage records)
-- ✅ User gets fresh $5 free tier limit
-- ✅ Logs the admin action for auditing
--
-- REDIS CLEANUP (run separately):
-- You may need to clear cache: DEL monthly_usage:USER_ID
--
-- ========================================================
