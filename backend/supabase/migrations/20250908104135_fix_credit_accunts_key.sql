ALTER TABLE credit_accounts 
DROP CONSTRAINT IF EXISTS credit_accounts_user_id_fkey;

ALTER TABLE credit_accounts 
ADD CONSTRAINT credit_accounts_account_id_fkey 
FOREIGN KEY (account_id) 
REFERENCES auth.users(id) 
ON DELETE CASCADE; 