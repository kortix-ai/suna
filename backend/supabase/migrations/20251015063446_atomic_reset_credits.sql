CREATE OR REPLACE FUNCTION atomic_reset_expiring_credits(
    p_account_id UUID,
    p_new_credits NUMERIC(10, 2),
    p_description TEXT DEFAULT 'Monthly credit renewal',
    p_stripe_event_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_current_balance NUMERIC(10, 2);
    v_current_expiring NUMERIC(10, 2);
    v_current_non_expiring NUMERIC(10, 2);
    v_actual_non_expiring NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_expires_at TIMESTAMP WITH TIME ZONE;
BEGIN
    SELECT 
        balance,
        expiring_credits,
        non_expiring_credits
    INTO 
        v_current_balance,
        v_current_expiring,
        v_current_non_expiring
    FROM public.credit_accounts
    WHERE account_id = p_account_id
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Account not found'
        );
    END IF;
    
    IF v_current_balance <= v_current_non_expiring THEN
        v_actual_non_expiring := v_current_balance;
    ELSE
        v_actual_non_expiring := v_current_non_expiring;
    END IF;
    
    v_new_total := p_new_credits + v_actual_non_expiring;
    
    v_expires_at := DATE_TRUNC('month', NOW() + INTERVAL '1 month') + INTERVAL '1 month';
    
    UPDATE public.credit_accounts
    SET 
        expiring_credits = p_new_credits,
        non_expiring_credits = v_actual_non_expiring,
        balance = v_new_total,
        updated_at = NOW()
    WHERE account_id = p_account_id;
    
    INSERT INTO public.credit_ledger (
        account_id,
        amount,
        balance_after,
        type,
        description,
        is_expiring,
        expires_at,
        stripe_event_id,
        metadata,
        processing_source
    ) VALUES (
        p_account_id,
        p_new_credits,
        v_new_total,
        'tier_grant',
        p_description,
        true,
        v_expires_at,
        p_stripe_event_id,
        jsonb_build_object(
            'renewal', true,
            'non_expiring_preserved', v_actual_non_expiring,
            'previous_balance', v_current_balance
        ),
        'atomic_function'
    );
    
    RETURN jsonb_build_object(
        'success', true,
        'new_expiring', p_new_credits,
        'non_expiring', v_actual_non_expiring,
        'total_balance', v_new_total
    );
END;
$$ LANGUAGE plpgsql;

