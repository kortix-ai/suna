-- OPTIONAL: Clear trial data for testing
-- Run this manually for specific test accounts only
-- DO NOT run this in production without careful consideration

-- To clear trial data for a specific account, run:
-- Replace 'YOUR_ACCOUNT_ID' with the actual account ID

/*
BEGIN;

-- Clear trial history
DELETE FROM trial_history 
WHERE account_id = 'YOUR_ACCOUNT_ID';

-- Clear trial-related credit ledger entries
DELETE FROM credit_ledger 
WHERE account_id = 'YOUR_ACCOUNT_ID' 
AND description LIKE '%trial%';

-- Reset trial status in credit_accounts
UPDATE credit_accounts 
SET 
    trial_status = 'none',
    trial_started_at = NULL,
    trial_ends_at = NULL
WHERE account_id = 'YOUR_ACCOUNT_ID';

COMMIT;
*/

-- For the specific user having issues:
-- Uncomment and run if needed for testing
/*
BEGIN;

DELETE FROM trial_history 
WHERE account_id = '210578c9-d8a0-4197-8cce-b866395a2080';

DELETE FROM credit_ledger 
WHERE account_id = '210578c9-d8a0-4197-8cce-b866395a2080' 
AND description LIKE '%trial%';

UPDATE credit_accounts 
SET 
    trial_status = 'none',
    trial_started_at = NULL,
    trial_ends_at = NULL
WHERE account_id = '210578c9-d8a0-4197-8cce-b866395a2080';

COMMIT;
*/ 