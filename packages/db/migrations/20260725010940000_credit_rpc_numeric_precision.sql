SET lock_timeout = '5s';
SET statement_timeout = '5min';

-- Preserve sub-cent wallet values inside every active credit RPC.
-- Unconstrained numeric variables inherit the precision of the table columns.

UPDATE kortix.credit_accounts
SET balance_precise = balance,
    lifetime_granted_precise = lifetime_granted,
    lifetime_purchased_precise = lifetime_purchased,
    lifetime_used_precise = lifetime_used,
    expiring_credits_precise = expiring_credits,
    non_expiring_credits_precise = non_expiring_credits,
    daily_credits_balance_precise = daily_credits_balance;

UPDATE kortix.credit_ledger
SET amount_precise = amount,
    balance_after_precise = balance_after;

CREATE FUNCTION kortix.sync_credit_account_precision_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance_precise = 0 AND NEW.balance <> 0 THEN
      NEW.balance_precise := NEW.balance;
    ELSE
      NEW.balance := ROUND(NEW.balance_precise, 4);
    END IF;

    IF NEW.lifetime_granted_precise = 0 AND NEW.lifetime_granted <> 0 THEN
      NEW.lifetime_granted_precise := NEW.lifetime_granted;
    ELSE
      NEW.lifetime_granted := ROUND(NEW.lifetime_granted_precise, 4);
    END IF;

    IF NEW.lifetime_purchased_precise = 0 AND NEW.lifetime_purchased <> 0 THEN
      NEW.lifetime_purchased_precise := NEW.lifetime_purchased;
    ELSE
      NEW.lifetime_purchased := ROUND(NEW.lifetime_purchased_precise, 4);
    END IF;

    IF NEW.lifetime_used_precise = 0 AND NEW.lifetime_used <> 0 THEN
      NEW.lifetime_used_precise := NEW.lifetime_used;
    ELSE
      NEW.lifetime_used := ROUND(NEW.lifetime_used_precise, 4);
    END IF;

    IF NEW.expiring_credits_precise = 0 AND NEW.expiring_credits <> 0 THEN
      NEW.expiring_credits_precise := NEW.expiring_credits;
    ELSE
      NEW.expiring_credits := ROUND(NEW.expiring_credits_precise, 4);
    END IF;

    IF NEW.non_expiring_credits_precise = 0 AND NEW.non_expiring_credits <> 0 THEN
      NEW.non_expiring_credits_precise := NEW.non_expiring_credits;
    ELSE
      NEW.non_expiring_credits := ROUND(NEW.non_expiring_credits_precise, 4);
    END IF;

    IF NEW.daily_credits_balance_precise = 0 AND NEW.daily_credits_balance <> 0 THEN
      NEW.daily_credits_balance_precise := NEW.daily_credits_balance;
    ELSE
      NEW.daily_credits_balance := ROUND(NEW.daily_credits_balance_precise, 2);
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.balance_precise IS DISTINCT FROM OLD.balance_precise THEN
    NEW.balance := ROUND(NEW.balance_precise, 4);
  ELSIF NEW.balance IS DISTINCT FROM OLD.balance THEN
    NEW.balance_precise := NEW.balance;
  END IF;

  IF NEW.lifetime_granted_precise IS DISTINCT FROM OLD.lifetime_granted_precise THEN
    NEW.lifetime_granted := ROUND(NEW.lifetime_granted_precise, 4);
  ELSIF NEW.lifetime_granted IS DISTINCT FROM OLD.lifetime_granted THEN
    NEW.lifetime_granted_precise := NEW.lifetime_granted;
  END IF;

  IF NEW.lifetime_purchased_precise IS DISTINCT FROM OLD.lifetime_purchased_precise THEN
    NEW.lifetime_purchased := ROUND(NEW.lifetime_purchased_precise, 4);
  ELSIF NEW.lifetime_purchased IS DISTINCT FROM OLD.lifetime_purchased THEN
    NEW.lifetime_purchased_precise := NEW.lifetime_purchased;
  END IF;

  IF NEW.lifetime_used_precise IS DISTINCT FROM OLD.lifetime_used_precise THEN
    NEW.lifetime_used := ROUND(NEW.lifetime_used_precise, 4);
  ELSIF NEW.lifetime_used IS DISTINCT FROM OLD.lifetime_used THEN
    NEW.lifetime_used_precise := NEW.lifetime_used;
  END IF;

  IF NEW.expiring_credits_precise IS DISTINCT FROM OLD.expiring_credits_precise THEN
    NEW.expiring_credits := ROUND(NEW.expiring_credits_precise, 4);
  ELSIF NEW.expiring_credits IS DISTINCT FROM OLD.expiring_credits THEN
    NEW.expiring_credits_precise := NEW.expiring_credits;
  END IF;

  IF NEW.non_expiring_credits_precise IS DISTINCT FROM OLD.non_expiring_credits_precise THEN
    NEW.non_expiring_credits := ROUND(NEW.non_expiring_credits_precise, 4);
  ELSIF NEW.non_expiring_credits IS DISTINCT FROM OLD.non_expiring_credits THEN
    NEW.non_expiring_credits_precise := NEW.non_expiring_credits;
  END IF;

  IF NEW.daily_credits_balance_precise IS DISTINCT FROM OLD.daily_credits_balance_precise THEN
    NEW.daily_credits_balance := ROUND(NEW.daily_credits_balance_precise, 2);
  ELSIF NEW.daily_credits_balance IS DISTINCT FROM OLD.daily_credits_balance THEN
    NEW.daily_credits_balance_precise := NEW.daily_credits_balance;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER sync_credit_account_precision_columns
BEFORE INSERT OR UPDATE ON kortix.credit_accounts
FOR EACH ROW
EXECUTE FUNCTION kortix.sync_credit_account_precision_columns();

CREATE FUNCTION kortix.sync_credit_ledger_precision_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.amount_precise = 0 AND NEW.amount <> 0 THEN
      NEW.amount_precise := NEW.amount;
    ELSE
      NEW.amount := ROUND(NEW.amount_precise, 4);
    END IF;

    IF NEW.balance_after_precise = 0 AND NEW.balance_after <> 0 THEN
      NEW.balance_after_precise := NEW.balance_after;
    ELSE
      NEW.balance_after := ROUND(NEW.balance_after_precise, 4);
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.amount_precise IS DISTINCT FROM OLD.amount_precise THEN
    NEW.amount := ROUND(NEW.amount_precise, 4);
  ELSIF NEW.amount IS DISTINCT FROM OLD.amount THEN
    NEW.amount_precise := NEW.amount;
  END IF;

  IF NEW.balance_after_precise IS DISTINCT FROM OLD.balance_after_precise THEN
    NEW.balance_after := ROUND(NEW.balance_after_precise, 4);
  ELSIF NEW.balance_after IS DISTINCT FROM OLD.balance_after THEN
    NEW.balance_after_precise := NEW.balance_after;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER sync_credit_ledger_precision_columns
BEFORE INSERT OR UPDATE ON kortix.credit_ledger
FOR EACH ROW
EXECUTE FUNCTION kortix.sync_credit_ledger_precision_columns();

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
    WHERE idempotency_key = p_idempotency_key
      AND created_at > NOW() - INTERVAL '1 hour'
  ) THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', 'Credit already added (idempotent)',
      'duplicate_prevented', true
    );
  END IF;

  SELECT expiring_credits_precise, non_expiring_credits_precise, balance_precise, tier
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
      account_id, expiring_credits_precise, non_expiring_credits_precise, balance_precise, tier
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
    account_id, amount_precise, balance_after_precise, type, description, metadata
  ) VALUES (
    p_account_id, -p_amount, v_nt, 'usage', p_description,
    jsonb_build_object(
      'from_daily', v_fd,
      'from_monthly', v_fe,
      'from_extra', v_fn,
      'ledger_type', p_ledger_type
    )
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

CREATE OR REPLACE FUNCTION public.atomic_use_credits(
  p_account_id uuid,
  p_amount numeric,
  p_description text DEFAULT 'Credit usage'::text,
  p_thread_id text DEFAULT NULL::text,
  p_message_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
  v_daily_balance numeric;
  v_expiring_balance numeric;
  v_non_expiring_balance numeric;
  v_total_balance numeric;
  v_amount_from_daily numeric := 0;
  v_amount_from_expiring numeric := 0;
  v_amount_from_non_expiring numeric := 0;
  v_remaining numeric;
  v_new_daily numeric;
  v_new_expiring numeric;
  v_new_non_expiring numeric;
  v_new_total numeric;
  v_transaction_id uuid;
BEGIN
  SELECT
    COALESCE(daily_credits_balance_precise, 0),
    COALESCE(expiring_credits_precise, 0),
    COALESCE(non_expiring_credits_precise, 0),
    COALESCE(balance_precise, 0)
  INTO
    v_daily_balance, v_expiring_balance, v_non_expiring_balance, v_total_balance
  FROM kortix.credit_accounts
  WHERE account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'No credit account found',
      'required', p_amount, 'available', 0
    );
  END IF;

  IF p_amount <= 0 THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'Amount must be positive',
      'required', p_amount, 'available', v_total_balance
    );
  END IF;

  IF v_total_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'Insufficient credits',
      'required', p_amount, 'available', v_total_balance
    );
  END IF;

  v_remaining := p_amount;
  IF v_remaining > 0 AND v_daily_balance > 0 THEN
    IF v_daily_balance >= v_remaining THEN
      v_amount_from_daily := v_remaining;
      v_remaining := 0;
    ELSE
      v_amount_from_daily := v_daily_balance;
      v_remaining := v_remaining - v_daily_balance;
    END IF;
  END IF;

  IF v_remaining > 0 AND v_expiring_balance > 0 THEN
    IF v_expiring_balance >= v_remaining THEN
      v_amount_from_expiring := v_remaining;
      v_remaining := 0;
    ELSE
      v_amount_from_expiring := v_expiring_balance;
      v_remaining := v_remaining - v_expiring_balance;
    END IF;
  END IF;

  IF v_remaining > 0 AND v_non_expiring_balance > 0 THEN
    v_amount_from_non_expiring := v_remaining;
    v_remaining := 0;
  END IF;

  v_new_daily := v_daily_balance - v_amount_from_daily;
  v_new_expiring := v_expiring_balance - v_amount_from_expiring;
  v_new_non_expiring := v_non_expiring_balance - v_amount_from_non_expiring;
  v_new_total := v_new_daily + v_new_expiring + v_new_non_expiring;

  UPDATE kortix.credit_accounts
  SET daily_credits_balance_precise = v_new_daily,
      expiring_credits_precise = v_new_expiring,
      non_expiring_credits_precise = v_new_non_expiring,
      balance_precise = v_new_total,
      updated_at = NOW()
  WHERE account_id = p_account_id;

  INSERT INTO kortix.credit_ledger (
    account_id, amount_precise, balance_after_precise, type, description, metadata
  ) VALUES (
    p_account_id, -p_amount, v_new_total, 'usage', p_description,
    jsonb_build_object(
      'from_daily', v_amount_from_daily,
      'from_monthly', v_amount_from_expiring,
      'from_extra', v_amount_from_non_expiring,
      'thread_id', p_thread_id,
      'message_id', p_message_id
    )
  ) RETURNING id INTO v_transaction_id;

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
$function$;
