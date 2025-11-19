CREATE OR REPLACE FUNCTION atomic_grant_renewal_credits(
    p_account_id UUID,
    p_period_start BIGINT,
    p_period_end BIGINT,
    p_credits NUMERIC(10, 2),
    p_processed_by TEXT,
    p_invoice_id TEXT DEFAULT NULL,
    p_stripe_event_id TEXT DEFAULT NULL,
    p_provider TEXT DEFAULT 'stripe',
    p_revenuecat_transaction_id TEXT DEFAULT NULL,
    p_revenuecat_product_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_already_processed BOOLEAN;
    v_existing_processor TEXT;
    v_current_non_expiring NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_expires_at TIMESTAMP WITH TIME ZONE;
    v_subscription_id TEXT;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM public.renewal_processing 
        WHERE account_id = p_account_id 
        AND period_start = p_period_start
    ), (
        SELECT processed_by FROM public.renewal_processing
        WHERE account_id = p_account_id
        AND period_start = p_period_start
        LIMIT 1
    ) INTO v_already_processed, v_existing_processor;
    
    IF v_already_processed THEN
        RAISE NOTICE '[ATOMIC RENEWAL] Period % already processed by % for account %', 
            p_period_start, v_existing_processor, p_account_id;
        
        RETURN jsonb_build_object(
            'success', false, 
            'reason', 'already_processed',
            'processed_by', v_existing_processor,
            'duplicate_prevented', true
        );
    END IF;
    
    -- Get subscription_id based on provider
    IF p_provider = 'revenuecat' THEN
        SELECT COALESCE(revenuecat_subscription_id, 'unknown')
        INTO v_subscription_id
        FROM public.credit_accounts
        WHERE account_id = p_account_id;
    ELSE
        SELECT COALESCE(stripe_subscription_id, 'unknown')
        INTO v_subscription_id
        FROM public.credit_accounts
        WHERE account_id = p_account_id;
    END IF;
    
    INSERT INTO public.renewal_processing (
        account_id, 
        period_start, 
        period_end, 
        subscription_id,
        processed_by, 
        credits_granted, 
        stripe_event_id,
        provider,
        revenuecat_transaction_id,
        revenuecat_product_id
    ) VALUES (
        p_account_id,
        p_period_start,
        p_period_end,
        v_subscription_id,
        p_processed_by,
        p_credits,
        p_stripe_event_id,
        p_provider,
        p_revenuecat_transaction_id,
        p_revenuecat_product_id
    );
    
    RAISE NOTICE '[ATOMIC RENEWAL] Marked period % as processing by % for account % (provider: %)',
        p_period_start, p_processed_by, p_account_id, p_provider;
    
    SELECT non_expiring_credits 
    INTO v_current_non_expiring
    FROM public.credit_accounts
    WHERE account_id = p_account_id;
    
    v_current_non_expiring := COALESCE(v_current_non_expiring, 0);
    v_new_total := p_credits + v_current_non_expiring;
    
    v_expires_at := TO_TIMESTAMP(p_period_end);
    
    UPDATE public.credit_accounts 
    SET 
        expiring_credits = p_credits,
        balance = v_new_total,
        last_grant_date = TO_TIMESTAMP(p_period_start),
        next_credit_grant = TO_TIMESTAMP(p_period_end),
        last_processed_invoice_id = COALESCE(p_invoice_id, last_processed_invoice_id),
        last_renewal_period_start = p_period_start,
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
        processing_source
    ) VALUES (
        p_account_id,
        p_credits,
        v_new_total,
        'tier_grant',
        'Monthly renewal: ' || p_processed_by,
        true,
        v_expires_at,
        p_stripe_event_id,
        p_processed_by
    );
    
    RAISE NOTICE '[ATOMIC RENEWAL] Granted % credits to account %, new balance: %',
        p_credits, p_account_id, v_new_total;
    
    RETURN jsonb_build_object(
        'success', true,
        'credits_granted', p_credits,
        'new_balance', v_new_total,
        'expiring_credits', p_credits,
        'non_expiring_credits', v_current_non_expiring,
        'processed_by', p_processed_by,
        'provider', p_provider
    );
    
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[ATOMIC RENEWAL] Error: % - %', SQLERRM, SQLSTATE;
    RETURN jsonb_build_object(
        'success', false,
        'reason', 'error',
        'error', SQLERRM
    );
END;
$$ LANGUAGE plpgsql;
