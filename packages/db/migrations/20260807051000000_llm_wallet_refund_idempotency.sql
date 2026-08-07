-- Migration: llm_wallet_refund_idempotency
--
-- `atomic_use_credits` already serializes an account before its durable replay
-- lookup. `atomic_add_credits` checked before taking that lock and limited the
-- lookup to one hour. Concurrent refunds could both pass the check, and a retry
-- after a restart could credit the wallet again. Lock first and keep request
-- keys durable for the lifetime of the ledger row.
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.atomic_add_credits(
  p_account_id uuid,
  p_amount numeric,
  p_is_expiring boolean DEFAULT true,
  p_description text DEFAULT 'Credit added'::text,
  p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_type text DEFAULT NULL::text,
  p_stripe_event_id text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
  v_current_expiring numeric;
  v_current_non_expiring numeric;
  v_current_balance numeric;
  v_new_expiring numeric;
  v_new_non_expiring numeric;
  v_new_total numeric;
  v_tier text;
  v_ledger_id uuid;
BEGIN
  -- Ensure an account row exists, then serialize every wallet mutation for this
  -- account before checking a replay key. ON CONFLICT also makes first-credit
  -- races converge on the same row lock.
  INSERT INTO kortix.credit_accounts (
    account_id, expiring_credits_precise, non_expiring_credits_precise,
    balance_precise, tier
  ) VALUES (
    p_account_id, 0, 0, 0, 'none'
  ) ON CONFLICT (account_id) DO NOTHING;

  SELECT expiring_credits_precise, non_expiring_credits_precise, balance_precise, tier
  INTO v_current_expiring, v_current_non_expiring, v_current_balance, v_tier
  FROM kortix.credit_accounts
  WHERE account_id = p_account_id
  FOR UPDATE;

  IF p_stripe_event_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM kortix.credit_ledger
    WHERE stripe_event_id = p_stripe_event_id
  ) THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', 'Credit already added (duplicate prevented)',
      'duplicate_prevented', true
    );
  END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1
    FROM kortix.credit_ledger
    WHERE account_id = p_account_id
      AND idempotency_key = p_idempotency_key
  ) THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', 'Credit already added (idempotent)',
      'duplicate_prevented', true
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
  SET expiring_credits_precise = v_new_expiring,
      non_expiring_credits_precise = v_new_non_expiring,
      balance_precise = v_new_total,
      updated_at = NOW()
  WHERE account_id = p_account_id;

  INSERT INTO kortix.credit_ledger (
    account_id, amount_precise, balance_after_precise, type, description,
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

GRANT EXECUTE ON FUNCTION public.atomic_add_credits(
  uuid, numeric, boolean, text, timestamp with time zone, text, text, text
) TO service_role, authenticated;
