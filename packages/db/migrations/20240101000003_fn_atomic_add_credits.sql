-- atomic_add_credits: Adds credits to an account.
-- Supports idempotency via stripe_event_id or idempotency_key.
-- Creates the credit_accounts row if it doesn't exist.
CREATE OR REPLACE FUNCTION public.atomic_add_credits(
    p_account_id UUID,
    p_amount NUMERIC,
    p_is_expiring BOOLEAN DEFAULT TRUE,
    p_description TEXT DEFAULT 'Credit added',
    p_expires_at TIMESTAMPTZ DEFAULT NULL,
    p_type TEXT DEFAULT NULL,
    p_stripe_event_id TEXT DEFAULT NULL,
    p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
    v_current_expiring NUMERIC(10, 2);
    v_current_non_expiring NUMERIC(10, 2);
    v_current_balance NUMERIC(10, 2);
    v_new_expiring NUMERIC(10, 2);
    v_new_non_expiring NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_tier TEXT;
    v_ledger_id UUID;
BEGIN
    -- Idempotency: check stripe_event_id
    IF p_stripe_event_id IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM kortix.credit_ledger
            WHERE stripe_event_id = p_stripe_event_id
        ) THEN
            RETURN jsonb_build_object(
                'success', true,
                'message', 'Credit already added (duplicate prevented)',
                'duplicate_prevented', true
            );
        END IF;
    END IF;

    -- Idempotency: check idempotency_key
    IF p_idempotency_key IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM kortix.credit_ledger
            WHERE idempotency_key = p_idempotency_key
            AND created_at > NOW() - INTERVAL '1 hour'
        ) THEN
            RETURN jsonb_build_object(
                'success', true,
                'message', 'Credit already added (idempotent)',
                'duplicate_prevented', true
            );
        END IF;
    END IF;

    SELECT expiring_credits, non_expiring_credits, balance, tier
    INTO v_current_expiring, v_current_non_expiring, v_current_balance, v_tier
    FROM kortix.credit_accounts
    WHERE account_id = p_account_id
    FOR UPDATE;

    IF NOT FOUND THEN
        v_current_expiring := 0;
        v_current_non_expiring := 0;
        v_current_balance := 0;
        v_tier := 'none';

        INSERT INTO kortix.credit_accounts (
            account_id, expiring_credits, non_expiring_credits, balance, tier
        ) VALUES (
            p_account_id, 0, 0, 0, v_tier
        );
    END IF;

    IF p_is_expiring THEN
        v_new_expiring := v_current_expiring + p_amount;
        v_new_non_expiring := v_current_non_expiring;
    ELSE
        v_new_expiring := v_current_expiring;
        v_new_non_expiring := v_current_non_expiring + p_amount;
    END IF;

    v_new_total := v_new_expiring + v_new_non_expiring;

    UPDATE kortix.credit_accounts
    SET
        expiring_credits = v_new_expiring,
        non_expiring_credits = v_new_non_expiring,
        balance = v_new_total,
        updated_at = NOW()
    WHERE account_id = p_account_id;

    INSERT INTO kortix.credit_ledger (
        account_id, amount, balance_after, type, description,
        is_expiring, expires_at, stripe_event_id, idempotency_key, processing_source
    ) VALUES (
        p_account_id, p_amount, v_new_total,
        COALESCE(p_type, CASE WHEN p_is_expiring THEN 'tier_grant' ELSE 'purchase' END),
        p_description, p_is_expiring, p_expires_at,
        p_stripe_event_id, p_idempotency_key, 'atomic_function'
    ) RETURNING id INTO v_ledger_id;

    RETURN jsonb_build_object(
        'success', true,
        'expiring_credits', v_new_expiring,
        'non_expiring_credits', v_new_non_expiring,
        'total_balance', v_new_total,
        'ledger_id', v_ledger_id
    );
END;
$function$;
