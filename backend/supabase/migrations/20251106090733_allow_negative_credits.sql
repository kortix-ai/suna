-- Allow negative credit balances (but controlled)
-- Users can only go slightly negative from a single request
-- Once negative, they cannot start new requests until they add credits

-- Step 1: Drop ALL table-level constraints that prevent negative balances
-- (there may be multiple constraint names from different migrations)
ALTER TABLE public.credit_accounts 
DROP CONSTRAINT IF EXISTS check_balance_non_negative;

ALTER TABLE public.credit_accounts 
DROP CONSTRAINT IF EXISTS check_no_negative_balance;

ALTER TABLE public.credit_accounts 
DROP CONSTRAINT IF EXISTS credit_accounts_balance_check;

ALTER TABLE public.credit_accounts 
DROP CONSTRAINT IF EXISTS check_no_negative_credits;

-- Drop any other CHECK constraints on balance-related columns
-- This covers any constraint we might have missed
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    FOR constraint_name IN 
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'public'
        AND rel.relname = 'credit_accounts'
        AND con.contype = 'c'  -- CHECK constraint
        AND EXISTS (
            SELECT 1 FROM unnest(con.conkey) AS key
            JOIN pg_attribute attr ON attr.attnum = key AND attr.attrelid = rel.oid
            WHERE attr.attname IN ('balance', 'expiring_credits', 'non_expiring_credits')
        )
    LOOP
        EXECUTE format('ALTER TABLE public.credit_accounts DROP CONSTRAINT IF EXISTS %I', constraint_name);
        RAISE NOTICE 'Dropped constraint: %', constraint_name;
    END LOOP;
END $$;

-- Step 2: Update the atomic function to allow negative deductions
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
    
    -- REMOVED: Hard balance check
    -- Now allows deduction even if it results in negative balance
    -- The check_and_reserve_credits function prevents starting new requests when negative
    
    -- Deduct from expiring credits first, then non-expiring
    -- This can result in negative balances for both
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
    
    -- Allow negative balances
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
        CASE 
            WHEN COALESCE(p_thread_id, p_message_id) IS NOT NULL 
            THEN COALESCE(p_thread_id, p_message_id)::uuid
            ELSE NULL
        END,
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
