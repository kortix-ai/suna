-- Prevent the four-argument debit function used by compute and LLM metering
-- from overdrawing an account. The row lock makes the balance check and debit
-- atomic with respect to concurrent grants and deductions.

CREATE OR REPLACE FUNCTION public.atomic_use_credits(
  p_account_id uuid,
  p_amount numeric,
  p_description text,
  p_ledger_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_daily NUMERIC(10,2);
  v_exp NUMERIC(10,2);
  v_nonexp NUMERIC(10,2);
  v_total NUMERIC(10,2);
  v_fd NUMERIC(10,2) := 0;
  v_fe NUMERIC(10,2) := 0;
  v_fn NUMERIC(10,2) := 0;
  v_rem NUMERIC(10,2);
  v_nd NUMERIC(10,2);
  v_ne NUMERIC(10,2);
  v_nn NUMERIC(10,2);
  v_nt NUMERIC(10,2);
  v_tid UUID;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be positive', 'required', p_amount, 'available', 0);
  END IF;

  SELECT
    COALESCE(daily_credits_balance, 0),
    COALESCE(expiring_credits, 0),
    COALESCE(non_expiring_credits, 0),
    COALESCE(balance, 0)
  INTO v_daily, v_exp, v_nonexp, v_total
  FROM kortix.credit_accounts
  WHERE account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No credit account found', 'required', p_amount, 'available', 0);
  END IF;

  IF v_total < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient credits', 'required', p_amount, 'available', v_total);
  END IF;

  v_rem := p_amount;
  IF v_rem > 0 AND v_daily > 0 THEN
    IF v_daily >= v_rem THEN v_fd := v_rem; v_rem := 0;
    ELSE v_fd := v_daily; v_rem := v_rem - v_daily;
    END IF;
  END IF;
  IF v_rem > 0 AND v_exp > 0 THEN
    IF v_exp >= v_rem THEN v_fe := v_rem; v_rem := 0;
    ELSE v_fe := v_exp; v_rem := v_rem - v_exp;
    END IF;
  END IF;
  IF v_rem > 0 THEN v_fn := v_rem; v_rem := 0; END IF;

  v_nd := v_daily - v_fd;
  v_ne := v_exp - v_fe;
  v_nn := v_nonexp - v_fn;
  v_nt := v_nd + v_ne + v_nn;

  UPDATE kortix.credit_accounts
  SET daily_credits_balance = v_nd,
      expiring_credits = v_ne,
      non_expiring_credits = v_nn,
      balance = v_nt,
      updated_at = NOW()
  WHERE account_id = p_account_id;

  INSERT INTO kortix.credit_ledger(account_id, amount, balance_after, type, description, metadata)
  VALUES (
    p_account_id,
    -p_amount,
    v_nt,
    'usage',
    p_description,
    jsonb_build_object('from_daily', v_fd, 'from_monthly', v_fe, 'from_extra', v_fn, 'ledger_type', p_ledger_type)
  )
  RETURNING id INTO v_tid;

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
