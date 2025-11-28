-- Part 2: Update atomic_use_credits function
-- This implements correct deduction order: Daily → Monthly → Extra

CREATE OR REPLACE FUNCTION atomic_use_credits(
    p_account_id UUID,
    p_amount NUMERIC(10, 2),
    p_description TEXT DEFAULT 'Credit usage',
    p_thread_id TEXT DEFAULT NULL,
    p_message_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_daily_balance NUMERIC(10, 2);
    v_expiring_balance NUMERIC(10, 2);
    v_non_expiring_balance NUMERIC(10, 2);
    v_total_balance NUMERIC(10, 2);
    v_amount_from_daily NUMERIC(10, 2) := 0;
    v_amount_from_expiring NUMERIC(10, 2) := 0;
    v_amount_from_non_expiring NUMERIC(10, 2) := 0;
    v_remaining NUMERIC(10, 2);
    v_new_daily NUMERIC(10, 2);
    v_new_expiring NUMERIC(10, 2);
    v_new_non_expiring NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_transaction_id UUID;
BEGIN
    -- Lock the row and get current balances
    SELECT 
        COALESCE(daily_credits_balance, 0),
        COALESCE(expiring_credits, 0),
        COALESCE(non_expiring_credits, 0),
        COALESCE(balance, 0)
    INTO 
        v_daily_balance,
        v_expiring_balance,
        v_non_expiring_balance,
        v_total_balance
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
    
    v_remaining := p_amount;
    
    -- Step 1: Deduct from DAILY credits first
    IF v_remaining > 0 AND v_daily_balance > 0 THEN
        IF v_daily_balance >= v_remaining THEN
            v_amount_from_daily := v_remaining;
            v_remaining := 0;
        ELSE
            v_amount_from_daily := v_daily_balance;
            v_remaining := v_remaining - v_daily_balance;
        END IF;
    END IF;
    
    -- Step 2: Deduct from MONTHLY (expiring) credits second
    IF v_remaining > 0 AND v_expiring_balance > 0 THEN
        IF v_expiring_balance >= v_remaining THEN
            v_amount_from_expiring := v_remaining;
            v_remaining := 0;
        ELSE
            v_amount_from_expiring := v_expiring_balance;
            v_remaining := v_remaining - v_expiring_balance;
        END IF;
    END IF;
    
    -- Step 3: Deduct from EXTRA (non-expiring) credits last
    IF v_remaining > 0 THEN
        v_amount_from_non_expiring := v_remaining;
        v_remaining := 0;
    END IF;
    
    -- Calculate new balances (can go negative for non_expiring if needed)
    v_new_daily := v_daily_balance - v_amount_from_daily;
    v_new_expiring := v_expiring_balance - v_amount_from_expiring;
    v_new_non_expiring := v_non_expiring_balance - v_amount_from_non_expiring;
    v_new_total := v_new_daily + v_new_expiring + v_new_non_expiring;
    
    -- Update the credit account
    UPDATE public.credit_accounts
    SET 
        daily_credits_balance = v_new_daily,
        expiring_credits = v_new_expiring,
        non_expiring_credits = v_new_non_expiring,
        balance = v_new_total,
        updated_at = NOW()
    WHERE account_id = p_account_id;
    
    -- Record the transaction in ledger
    INSERT INTO public.credit_ledger (
        account_id, 
        amount, 
        balance_after, 
        type, 
        description,
        metadata
    ) VALUES (
        p_account_id,
        -p_amount,
        v_new_total,
        'usage',
        p_description,
        jsonb_build_object(
            'from_daily', v_amount_from_daily,
            'from_monthly', v_amount_from_expiring,
            'from_extra', v_amount_from_non_expiring,
            'thread_id', p_thread_id,
            'message_id', p_message_id
        )
    )
    RETURNING id INTO v_transaction_id;
    
    RETURN jsonb_build_object(
        'success', true,
        'amount_deducted', p_amount,
        'new_total', v_new_total,
        'new_daily', v_new_daily,
        'new_expiring', v_new_expiring,
        'new_non_expiring', v_new_non_expiring,
        'from_daily', v_amount_from_daily,
        'from_monthly', v_amount_from_expiring,
        'from_extra', v_amount_from_non_expiring,
        'from_expiring', v_amount_from_expiring,
        'from_non_expiring', v_amount_from_non_expiring,
        'transaction_id', v_transaction_id
    );
END;
$$ LANGUAGE plpgsql;

