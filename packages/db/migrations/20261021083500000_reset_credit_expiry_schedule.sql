-- Record only caller-supplied reset expiry; never infer a calendar date.
-- Existing ledger rows are intentionally unchanged.
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE OR REPLACE FUNCTION kortix_wallet.reset_expiring_credits(
  p_account_id uuid,
  p_new_credits numeric,
  p_description text,
  p_stripe_event_id text,
  p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
    v_current_balance numeric;
    v_current_non_expiring numeric;
    v_actual_non_expiring numeric;
    v_new_total numeric;
    v_expires_at TIMESTAMP WITH TIME ZONE;
BEGIN
    SELECT balance_precise, non_expiring_credits_precise
    INTO v_current_balance, v_current_non_expiring
    FROM kortix.credit_accounts
    WHERE account_id = p_account_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Account not found');
    END IF;

    IF v_current_balance <= v_current_non_expiring THEN
        v_actual_non_expiring := v_current_balance;
    ELSE
        v_actual_non_expiring := v_current_non_expiring;
    END IF;

    v_new_total := p_new_credits + v_actual_non_expiring;
    v_expires_at := p_expires_at;

    UPDATE kortix.credit_accounts
    SET
        expiring_credits_precise = p_new_credits,
        non_expiring_credits_precise = v_actual_non_expiring,
        balance_precise = v_new_total,
        updated_at = NOW()
    WHERE account_id = p_account_id;

    INSERT INTO kortix.credit_ledger (
        account_id, amount_precise, balance_after_precise, type, description,
        is_expiring, expires_at, stripe_event_id, metadata, processing_source
    ) VALUES (
        p_account_id, p_new_credits, v_new_total, 'tier_grant', p_description,
        true, v_expires_at, p_stripe_event_id,
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
$function$;

-- Mixed-version callers have no authoritative schedule: leave expiry unknown.
CREATE OR REPLACE FUNCTION kortix_wallet.reset_expiring_credits(
  p_account_id uuid, p_new_credits numeric, p_description text, p_stripe_event_id text
) RETURNS jsonb LANGUAGE sql SET search_path TO '' AS $function$
  SELECT kortix_wallet.reset_expiring_credits(
    p_account_id, p_new_credits, p_description, p_stripe_event_id, NULL::timestamptz
  );
$function$;

REVOKE EXECUTE ON FUNCTION kortix_wallet.reset_expiring_credits(uuid, numeric, text, text, timestamptz) FROM PUBLIC;
DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION kortix_wallet.reset_expiring_credits(uuid, numeric, text, text, timestamptz) TO service_role;
  END IF;
END;
$block$;
