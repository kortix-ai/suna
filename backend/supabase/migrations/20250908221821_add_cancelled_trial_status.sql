BEGIN;

ALTER TABLE credit_accounts 
DROP CONSTRAINT IF EXISTS credit_accounts_trial_status_check;

ALTER TABLE credit_accounts 
ADD CONSTRAINT credit_accounts_trial_status_check 
CHECK (trial_status IN ('none', 'active', 'expired', 'converted', 'cancelled'));

COMMIT; 
