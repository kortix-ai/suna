BEGIN;

ALTER TABLE credit_ledger 
ADD COLUMN IF NOT EXISTS stripe_event_id VARCHAR(255);

ALTER TABLE credit_ledger 
ADD CONSTRAINT unique_stripe_event UNIQUE(stripe_event_id);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_stripe_event 
ON credit_ledger(stripe_event_id) 
WHERE stripe_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_accounts_commitment 
ON credit_accounts(account_id, commitment_end_date) 
WHERE commitment_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_accounts_expiry 
ON credit_accounts(account_id, next_credit_grant) 
WHERE expiring_credits > 0;

CREATE OR REPLACE FUNCTION cleanup_expired_credits() 
RETURNS TABLE(
    account_id UUID,
    credits_removed DECIMAL,
    new_balance DECIMAL
) 
SECURITY DEFINER
AS $$
DECLARE
    v_account RECORD;
    v_credits_to_remove DECIMAL;
    v_new_balance DECIMAL;
BEGIN
    FOR v_account IN 
        SELECT 
            ca.account_id,
            ca.expiring_credits,
            ca.non_expiring_credits,
            ca.balance,
            ca.next_credit_grant,
            ca.tier,
            ca.stripe_subscription_id
        FROM credit_accounts ca
        WHERE ca.expiring_credits > 0
        AND (
            (ca.tier IS NULL OR ca.tier = 'none') 
            OR (ca.stripe_subscription_id IS NULL AND ca.next_credit_grant < NOW() - INTERVAL '30 days')
        )
        AND (ca.trial_status IS NULL OR ca.trial_status NOT IN ('active'))
    LOOP
        v_credits_to_remove := v_account.expiring_credits;
        v_new_balance := v_account.non_expiring_credits;
        
        UPDATE credit_accounts
        SET 
            expiring_credits = 0,
            balance = v_new_balance,
            updated_at = NOW()
        WHERE account_id = v_account.account_id;
        
        INSERT INTO credit_ledger (
            account_id,
            amount,
            balance_after,
            type,
            description,
            is_expiring
        ) VALUES (
            v_account.account_id,
            -v_credits_to_remove,
            v_new_balance,
            'expired',
            'Cleanup of expired credits after subscription cancellation',
            true
        );
        
        account_id := v_account.account_id;
        credits_removed := v_credits_to_remove;
        new_balance := v_new_balance;
        RETURN NEXT;
    END LOOP;
    
    RETURN;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reconcile_credit_balance(p_account_id UUID)
RETURNS TABLE(
    was_fixed BOOLEAN,
    old_balance DECIMAL,
    new_balance DECIMAL,
    difference DECIMAL
) 
SECURITY DEFINER
AS $$
DECLARE
    v_current RECORD;
    v_calculated_total DECIMAL;
    v_needs_fix BOOLEAN := FALSE;
BEGIN
    SELECT 
        balance,
        expiring_credits,
        non_expiring_credits
    INTO v_current
    FROM credit_accounts
    WHERE account_id = p_account_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Account not found: %', p_account_id;
    END IF;
    
    v_calculated_total := v_current.expiring_credits + v_current.non_expiring_credits;
    
    IF ABS(v_current.balance - v_calculated_total) > 0.01 THEN
        v_needs_fix := TRUE;
        
        UPDATE credit_accounts
        SET 
            balance = v_calculated_total,
            updated_at = NOW()
        WHERE account_id = p_account_id;
        
        INSERT INTO credit_ledger (
            account_id,
            amount,
            balance_after,
            type,
            description,
            metadata
        ) VALUES (
            p_account_id,
            v_calculated_total - v_current.balance,
            v_calculated_total,
            'adjustment',
            'Automatic balance reconciliation',
            jsonb_build_object(
                'old_balance', v_current.balance,
                'old_expiring', v_current.expiring_credits,
                'old_non_expiring', v_current.non_expiring_credits,
                'reconciled_at', NOW()
            )
        );
    END IF;
    
    was_fixed := v_needs_fix;
    old_balance := v_current.balance;
    new_balance := v_calculated_total;
    difference := v_calculated_total - v_current.balance;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

UPDATE credit_accounts
SET commitment_end_date = commitment_start_date::timestamp + INTERVAL '1 year'
WHERE commitment_type = 'yearly_commitment'
AND commitment_end_date != commitment_start_date::timestamp + INTERVAL '1 year';

CREATE OR REPLACE VIEW billing_health_check AS
SELECT 
    'balance_discrepancies' as check_type,
    COUNT(*) as issue_count,
    jsonb_agg(jsonb_build_object(
        'account_id', account_id,
        'balance', balance,
        'calculated', expiring_credits + non_expiring_credits,
        'difference', balance - (expiring_credits + non_expiring_credits)
    )) as details
FROM credit_accounts
WHERE ABS(balance - (expiring_credits + non_expiring_credits)) > 0.01

UNION ALL

SELECT 
    'expired_credits_not_cleaned' as check_type,
    COUNT(*) as issue_count,
    jsonb_agg(jsonb_build_object(
        'account_id', account_id,
        'expiring_credits', expiring_credits,
        'tier', tier,
        'subscription_id', stripe_subscription_id,
        'next_grant', next_credit_grant
    )) as details
FROM credit_accounts
WHERE expiring_credits > 0
AND (
    (tier IS NULL OR tier = 'none')
    OR (stripe_subscription_id IS NULL AND next_credit_grant < NOW() - INTERVAL '30 days')
)
AND (trial_status IS NULL OR trial_status NOT IN ('active'))

UNION ALL

SELECT 
    'invalid_commitment_dates' as check_type,
    COUNT(*) as issue_count,
    jsonb_agg(jsonb_build_object(
        'account_id', account_id,
        'start_date', commitment_start_date,
        'end_date', commitment_end_date,
        'expected_end', commitment_start_date::timestamp + INTERVAL '1 year'
    )) as details
FROM credit_accounts
WHERE commitment_type = 'yearly_commitment'
AND commitment_end_date != commitment_start_date::timestamp + INTERVAL '1 year';

GRANT SELECT ON billing_health_check TO authenticated;
GRANT EXECUTE ON FUNCTION cleanup_expired_credits() TO service_role;
GRANT EXECUTE ON FUNCTION reconcile_credit_balance(UUID) TO service_role;

COMMIT;
