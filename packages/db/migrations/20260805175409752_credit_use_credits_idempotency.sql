-- Migration: credit_use_credits_idempotency
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHY
--
-- `atomic_use_credits` had no idempotency key, so a debit whose RPC response
-- was lost AFTER the function committed was invisible to the caller: the wallet
-- was debited, the code believed it was not, and the next metering tick charged
-- the same window again in full. Commit-then-timeout is the ordinary failure
-- mode of a pooled Postgres RPC under load, not an exotic one.
--
-- `atomic_add_credits` (grants) has taken `p_idempotency_key` since the
-- baseline and short-circuits on an existing ledger row. Debits deliberately
-- did not. This makes the two symmetric.
--
-- FUNCTION-ONLY: no table, column, index, constraint or enum is touched, so the
-- expand/contract checklist above does not apply. The signature is REPLACED
-- rather than overloaded — 20260730012238065 consolidated this function to a
-- single overload on purpose, and re-introducing a second one would make the
-- call ambiguous from PostgREST.
--
-- The existing per-account `FOR UPDATE` serializes concurrent debits for one
-- account, so the check-then-insert below cannot interleave with itself. That
-- is the same guarantee `atomic_add_credits` relies on; the partial btree index
-- `idx_credit_ledger_idempotency` keeps the lookup cheap.

DROP FUNCTION IF EXISTS public.atomic_use_credits(uuid, numeric, text, text);

CREATE OR REPLACE FUNCTION public.atomic_use_credits(
  p_account_id uuid,
  p_amount numeric,
  p_description text DEFAULT 'Credit usage'::text,
  p_ledger_type text DEFAULT 'usage'::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_daily numeric;
  v_exp numeric;
  v_nonexp numeric;
  v_total numeric;
  v_fd numeric := 0;
  v_fe numeric := 0;
  v_fn numeric := 0;
  v_rem numeric;
  v_nd numeric;
  v_ne numeric;
  v_nn numeric;
  v_nt numeric;
  v_tid uuid;
  v_existing kortix.credit_ledger%ROWTYPE;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'Amount must be positive',
      'required', p_amount, 'available', 0
    );
  END IF;

  SELECT
    COALESCE(daily_credits_balance_precise, 0),
    COALESCE(expiring_credits_precise, 0),
    COALESCE(non_expiring_credits_precise, 0),
    COALESCE(balance_precise, 0)
  INTO v_daily, v_exp, v_nonexp, v_total
  FROM kortix.credit_accounts
  WHERE account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'No credit account found',
      'required', p_amount, 'available', 0
    );
  END IF;

  -- Replay check. Deliberately AFTER the FOR UPDATE so a concurrent debit for
  -- the same account cannot slip between the lookup and the insert, and BEFORE
  -- the balance test so a replay succeeds even once the wallet has since been
  -- drained — the money for this key already moved, and reporting failure would
  -- send the caller round to charge it again.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM kortix.credit_ledger
    WHERE idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'replayed', true,
        'amount_deducted', ABS(COALESCE(v_existing.amount_precise, v_existing.amount, 0)),
        'new_total', v_total,
        'transaction_id', v_existing.id
      );
    END IF;
  END IF;

  IF v_total < p_amount THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'Insufficient credits',
      'required', p_amount, 'available', v_total
    );
  END IF;

  v_rem := p_amount;
  IF v_rem > 0 AND v_daily > 0 THEN
    IF v_daily >= v_rem THEN
      v_fd := v_rem;
      v_rem := 0;
    ELSE
      v_fd := v_daily;
      v_rem := v_rem - v_daily;
    END IF;
  END IF;
  IF v_rem > 0 AND v_exp > 0 THEN
    IF v_exp >= v_rem THEN
      v_fe := v_rem;
      v_rem := 0;
    ELSE
      v_fe := v_exp;
      v_rem := v_rem - v_exp;
    END IF;
  END IF;
  IF v_rem > 0 THEN
    v_fn := v_rem;
    v_rem := 0;
  END IF;

  v_nd := v_daily - v_fd;
  v_ne := v_exp - v_fe;
  v_nn := v_nonexp - v_fn;
  v_nt := v_nd + v_ne + v_nn;

  UPDATE kortix.credit_accounts
  SET daily_credits_balance_precise = v_nd,
      expiring_credits_precise = v_ne,
      non_expiring_credits_precise = v_nn,
      balance_precise = v_nt,
      updated_at = NOW()
  WHERE account_id = p_account_id;

  INSERT INTO kortix.credit_ledger (
    account_id, amount_precise, balance_after_precise, type, description,
    metadata, idempotency_key
  ) VALUES (
    p_account_id, -p_amount, v_nt, 'usage', p_description,
    jsonb_build_object(
      'from_daily', v_fd,
      'from_monthly', v_fe,
      'from_extra', v_fn,
      'ledger_type', p_ledger_type
    ),
    p_idempotency_key
  ) RETURNING id INTO v_tid;

  RETURN jsonb_build_object(
    'success', true,
    'amount_deducted', p_amount,
    'new_total', v_nt,
    'new_daily', v_nd,
    'new_expiring', v_ne,
    'new_non_expiring', v_nn,
    'from_daily', v_fd,
    'from_monthly', v_fe,
    'from_extra', v_fn,
    'from_expiring', v_fe,
    'from_non_expiring', v_fn,
    'transaction_id', v_tid
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.atomic_use_credits(uuid, numeric, text, text, text)
  TO service_role, authenticated;
