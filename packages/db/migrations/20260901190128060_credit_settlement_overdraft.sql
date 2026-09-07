-- credit_settlement_overdraft
--
-- Separates the two questions the wallet was answering with one function.
--
--   ADMISSION  — "may this account START work?"      strict floor, never negative
--   SETTLEMENT — "record work already DONE"          must always succeed
--
-- `atomic_use_credits` refuses any debit that would take the balance below zero.
-- That is correct for admission and WRONG for settlement, because settlement
-- reports consumption that has already happened. Refusing it does not un-spend
-- the money; it only deletes the record of it.
--
-- Measured consequence (2026-09-01, a 6-seat Team account): the wallet sat at
-- $0.00 while $588.81 of usage settled against a $150/mo seat grant. Every
-- further debit returned `success:false`, no `credit_ledger` row was written,
-- and "Spent this period" — which SUMs credit_ledger — silently stopped moving
-- while compute kept burning. The last line of defence stopped the bookkeeping
-- instead of the spending.
--
-- With the wallet floor now universal (no subscription bypasses it), the
-- residual is bounded and unavoidable: admission holds $0.01, and a turn that
-- costs more than the remaining balance under-collects by the difference. That
-- is one turn per account per drain cycle — exactly the turn whose cost used to
-- vanish. Recording it as an overdraft makes the ledger complete AND makes the
-- account MORE blocked, because the next admission reads a negative balance.
--
-- No new table, no column, no backfill, no index: the debt is written exactly
-- once, atomically, by the code path that already runs. The alternative — an
-- unsettled-debit table plus a retry sweeper — is eventually consistent where
-- this is immediately correct.
--
-- Overdraft lands in `non_expiring_credits_precise`: the existing waterfall
-- already routes the remainder there (`IF v_rem > 0 THEN v_fn := v_rem`), so a
-- negative bucket needs no new arithmetic. Granted and expiring credit can
-- never go negative — only the account's own purchased/extra bucket does, which
-- is what an unpaid balance IS.
--
-- mixed-version-safe: additive only. `atomic_use_credits` is untouched, so an
-- old pod keeps refusing overdrafts (the pre-change behaviour) while a new pod
-- records them. Neither can corrupt the other's rows; both write the same
-- ledger shape.

-- `CREATE OR REPLACE FUNCTION` takes no table lock, so the house 5s defaults are
-- correct here. This is NOT a concurrent-index migration and must not borrow the
-- long lock_timeout those require.
set lock_timeout = '5s';
set statement_timeout = '5s';

CREATE OR REPLACE FUNCTION public.atomic_settle_credits(
  p_account_id uuid,
  p_amount numeric,
  p_description text DEFAULT 'Credit settlement'::text,
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

  -- A settlement for an account with no credit row is a real failure: there is
  -- nothing to write the debt against. The caller logs and alerts.
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'No credit account found',
      'required', p_amount, 'available', 0
    );
  END IF;

  -- Replay check, identical to atomic_use_credits and for the same reason: the
  -- money for this key already moved, so reporting failure would send the
  -- caller round to charge it again. Deliberately AFTER the FOR UPDATE.
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

  -- NO BALANCE CHECK. This is the entire difference from atomic_use_credits,
  -- and it is the point of this function. Work that has already been performed
  -- is always recorded.

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
  -- The remainder always lands here, and may take this bucket negative.
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
      'ledger_type', p_ledger_type,
      -- Marks the rows that took the account below zero, so the overdrawn
      -- population is one query away rather than a reconstruction.
      'overdraft', v_nt < 0
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
    'overdraft', v_nt < 0,
    'transaction_id', v_tid
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.atomic_settle_credits(uuid, numeric, text, text, text)
  TO service_role, authenticated;
