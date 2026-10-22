-- Migration: reset_expiring_credits_precision
--
-- kortix_wallet.reset_expiring_credits kept NUMERIC(10, 2) variables and read the
-- 4-decimal legacy columns through them. Every monthly renewal rounded the
-- preserved non-expiring bucket to cents: 12.3456 became 12.35, and a debt of
-- -0.004 became 0.00 (up to $0.005 per renewal, per account). grant_credits and
-- debit_credits already use the *_precise columns with unconstrained numeric.
-- This body does the same. The precision trigger keeps the legacy columns in
-- step. The result shape, the ledger row shape and the daily-bucket behaviour
-- are unchanged.
--
-- CREATE OR REPLACE keeps the function owner and ACL. No table is touched.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';


CREATE OR REPLACE FUNCTION kortix_wallet.reset_expiring_credits(
  p_account_id uuid,
  p_new_credits numeric,
  p_description text,
  p_stripe_event_id text
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
    v_expires_at := DATE_TRUNC('month', NOW() + INTERVAL '1 month') + INTERVAL '1 month';

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
