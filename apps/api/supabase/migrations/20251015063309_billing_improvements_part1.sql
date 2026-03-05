BEGIN;
DO $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM credit_accounts
    WHERE ABS(balance - (expiring_credits + non_expiring_credits)) > 0.01;
    
    IF v_count > 0 THEN
        RAISE NOTICE 'Found % accounts with balance discrepancies, reconciling...', v_count;
        
        INSERT INTO credit_ledger (account_id, amount, balance_after, type, description, created_at)
        SELECT 
            account_id,
            (expiring_credits + non_expiring_credits) - balance as amount,
            expiring_credits + non_expiring_credits as balance_after,
            'adjustment' as type,
            'Automatic balance reconciliation during migration' as description,
            NOW() as created_at
        FROM credit_accounts
        WHERE ABS(balance - (expiring_credits + non_expiring_credits)) > 0.01;

        UPDATE credit_accounts
        SET balance = expiring_credits + non_expiring_credits,
            updated_at = NOW()
        WHERE ABS(balance - (expiring_credits + non_expiring_credits)) > 0.01;
        
        RAISE NOTICE 'Successfully reconciled % accounts', v_count;
    ELSE
        RAISE NOTICE 'No balance discrepancies found';
    END IF;
END $$;


ALTER TABLE credit_accounts 
DROP CONSTRAINT IF EXISTS check_no_negative_balance;
ALTER TABLE credit_accounts 
ADD CONSTRAINT check_no_negative_balance 
CHECK (balance >= 0);

ALTER TABLE credit_accounts 
DROP CONSTRAINT IF EXISTS check_no_negative_credits;
ALTER TABLE credit_accounts 
ADD CONSTRAINT check_no_negative_credits 
CHECK (expiring_credits >= 0 AND non_expiring_credits >= 0);

ALTER TABLE credit_accounts 
DROP CONSTRAINT IF EXISTS check_balance_consistency;
ALTER TABLE credit_accounts 
ADD CONSTRAINT check_balance_consistency 
CHECK (ABS(balance - (expiring_credits + non_expiring_credits)) < 0.01);

ALTER TABLE trial_history 
DROP CONSTRAINT IF EXISTS unique_account_trial;
ALTER TABLE trial_history 
ADD CONSTRAINT unique_account_trial 
UNIQUE(account_id);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_recent_ops 
ON credit_ledger(account_id, created_at DESC, amount, description);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_commitment_active 
ON credit_accounts(account_id, commitment_end_date) 
WHERE commitment_type IS NOT NULL;

ALTER TABLE credit_ledger 
ADD COLUMN IF NOT EXISTS message_id UUID,
ADD COLUMN IF NOT EXISTS thread_id UUID,
ADD COLUMN IF NOT EXISTS reference_id UUID;

COMMIT;
