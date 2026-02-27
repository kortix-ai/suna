CREATE OR REPLACE FUNCTION atomic_use_credits(
    p_account_id UUID,
    p_amount NUMERIC(10, 2),
    p_description TEXT DEFAULT 'Credit usage',
    p_thread_id TEXT DEFAULT NULL,
    p_message_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_current_expiring NUMERIC(10, 2);
    v_current_non_expiring NUMERIC(10, 2);
    v_current_balance NUMERIC(10, 2);
    v_amount_from_expiring NUMERIC(10, 2);
    v_amount_from_non_expiring NUMERIC(10, 2);
    v_new_expiring NUMERIC(10, 2);
    v_new_non_expiring NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
BEGIN
    SELECT 
        expiring_credits,
        non_expiring_credits,
        balance
    INTO 
        v_current_expiring,
        v_current_non_expiring,
        v_current_balance
    FROM public.credit_accounts
    WHERE account_id = p_account_id
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'No credit account found',
            'required', p_amount,
            'available', 0
        );
    END IF;
    
    IF v_current_balance < p_amount THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Insufficient credits',
            'required', p_amount,
            'available', v_current_balance
        );
    END IF;
    
    IF v_current_expiring >= p_amount THEN
        v_amount_from_expiring := p_amount;
        v_amount_from_non_expiring := 0;
    ELSE
        v_amount_from_expiring := v_current_expiring;
        v_amount_from_non_expiring := p_amount - v_current_expiring;
    END IF;
    
    v_new_expiring := v_current_expiring - v_amount_from_expiring;
    v_new_non_expiring := v_current_non_expiring - v_amount_from_non_expiring;
    v_new_total := v_new_expiring + v_new_non_expiring;
    
    UPDATE public.credit_accounts
    SET 
        expiring_credits = v_new_expiring,
        non_expiring_credits = v_new_non_expiring,
        balance = v_new_total,
        updated_at = NOW()
    WHERE account_id = p_account_id;
    
    INSERT INTO public.credit_ledger (
        account_id,
        amount,
        balance_after,
        type,
        description,
        reference_id,
        metadata,
        processing_source
    ) VALUES (
        p_account_id,
        -p_amount,
        v_new_total,
        'usage',
        p_description,
        COALESCE(p_thread_id, p_message_id),
        jsonb_build_object(
            'thread_id', p_thread_id,
            'message_id', p_message_id,
            'from_expiring', v_amount_from_expiring,
            'from_non_expiring', v_amount_from_non_expiring
        ),
        'atomic_function'
    );
    
    RETURN jsonb_build_object(
        'success', true,
        'amount_deducted', p_amount,
        'from_expiring', v_amount_from_expiring,
        'from_non_expiring', v_amount_from_non_expiring,
        'new_expiring', v_new_expiring,
        'new_non_expiring', v_new_non_expiring,
        'new_total', v_new_total
    );
END;
$$ LANGUAGE plpgsql;

