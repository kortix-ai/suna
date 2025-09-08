BEGIN;

UPDATE credit_accounts 
SET last_grant_date = last_grant_at 
WHERE last_grant_date IS NULL AND last_grant_at IS NOT NULL;

ALTER TABLE credit_accounts 
DROP COLUMN IF EXISTS last_grant_at;

ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS last_grant_date TIMESTAMPTZ;

DROP INDEX IF EXISTS idx_credit_accounts_last_grant;
CREATE INDEX idx_credit_accounts_last_grant ON credit_accounts(last_grant_date);

CREATE OR REPLACE FUNCTION grant_tier_credits(
    p_user_id UUID,
    p_tier TEXT,
    p_amount DECIMAL
) RETURNS BOOLEAN AS $$
DECLARE
    v_balance DECIMAL;
BEGIN
    SELECT balance INTO v_balance
    FROM credit_accounts
    WHERE user_id = p_user_id
    FOR UPDATE;
    
    IF NOT FOUND THEN
        INSERT INTO credit_accounts (user_id, balance, tier, last_grant_date)
        VALUES (p_user_id, p_amount, p_tier, NOW());
    ELSE
        UPDATE credit_accounts
        SET 
            balance = balance + p_amount,
            tier = p_tier,
            last_grant_date = NOW(),
            updated_at = NOW()
        WHERE user_id = p_user_id;
    END IF;
    
    INSERT INTO credit_grants (user_id, amount, tier, granted_at)
    VALUES (p_user_id, p_amount, p_tier, NOW());
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN credit_accounts.last_grant_date IS 'Timestamp of the last credit grant to this account';

COMMIT; 