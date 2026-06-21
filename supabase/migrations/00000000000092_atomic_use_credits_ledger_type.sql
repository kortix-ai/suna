-- atomic_use_credits(p_account_id, p_amount, p_description, p_ledger_type)
--
-- The billing service (apps/api/src/billing/services/credits.ts) deducts credits
-- through PostgREST with exactly these four NAMED args. This migration originally
-- created a SIX-arg overload (… p_thread_id, p_message_id, p_ledger_type) which
-- caused the 2026-06-19 prod billing outage (1.4k errs/hr, usage unbilled). Two
-- things were wrong; both are fixed to match the live prod hotfix:
--
--   1. Signature drift / ambiguity. The 6-arg form is reachable by the 4-named-arg
--      call (the extra two default), but the moment a 4-arg overload also exists
--      PostgREST raises "function atomic_use_credits is not unique". We DROP the
--      6-arg form and keep a single, unambiguous 4-arg function. The raw-SQL,
--      3-POSITIONAL caller (apps/api/src/repositories/credits.ts) still resolves
--      to the original 5-arg atomic_use_credits(uuid,numeric,text,text,text) from
--      migration 0002 — making p_ledger_type REQUIRED here (no default) is what
--      keeps the 4-arg and 5-arg forms from ever colliding on a 3-arg call.
--
--   2. Schema access. PostgREST executes as `service_role`, which has no USAGE on
--      the internal `kortix` schema, so a SECURITY INVOKER body 403s ("permission
--      denied for schema kortix") — which is why the PostgREST deduction path had
--      NEVER worked. SECURITY DEFINER runs it as the owner (which owns kortix);
--      EXECUTE is granted to service_role ONLY (a credit-DEBIT function must never
--      be callable by an end-user role).
--
-- Behaviour is byte-for-byte the live 5-arg function: deduct daily → expiring →
-- non-expiring; ledger row typed 'usage' with the requested ledger_type carried in
-- metadata, so downstream usage reports that filter on type='usage' are unchanged.
-- Idempotent + re-runnable (this file is re-applied on every dev boot).

DO $$
BEGIN
  EXECUTE 'DROP FUNCTION IF EXISTS public.atomic_use_credits(uuid, numeric, text, text, text, text)';

  EXECUTE $sql$
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
          v_daily NUMERIC(10,2); v_exp NUMERIC(10,2); v_nonexp NUMERIC(10,2); v_total NUMERIC(10,2);
          v_fd NUMERIC(10,2):=0; v_fe NUMERIC(10,2):=0; v_fn NUMERIC(10,2):=0;
          v_rem NUMERIC(10,2); v_nd NUMERIC(10,2); v_ne NUMERIC(10,2); v_nn NUMERIC(10,2); v_nt NUMERIC(10,2);
          v_tid UUID;
        BEGIN
          SELECT COALESCE(daily_credits_balance,0),COALESCE(expiring_credits,0),
                 COALESCE(non_expiring_credits,0),COALESCE(balance,0)
          INTO v_daily,v_exp,v_nonexp,v_total
          FROM kortix.credit_accounts WHERE account_id=p_account_id FOR UPDATE;
          IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','No credit account found','required',p_amount,'available',0); END IF;
          v_rem:=p_amount;
          IF v_rem>0 AND v_daily>0 THEN IF v_daily>=v_rem THEN v_fd:=v_rem;v_rem:=0; ELSE v_fd:=v_daily;v_rem:=v_rem-v_daily; END IF; END IF;
          IF v_rem>0 AND v_exp>0 THEN IF v_exp>=v_rem THEN v_fe:=v_rem;v_rem:=0; ELSE v_fe:=v_exp;v_rem:=v_rem-v_exp; END IF; END IF;
          IF v_rem>0 THEN v_fn:=v_rem;v_rem:=0; END IF;
          v_nd:=v_daily-v_fd; v_ne:=v_exp-v_fe; v_nn:=v_nonexp-v_fn; v_nt:=v_nd+v_ne+v_nn;
          UPDATE kortix.credit_accounts SET daily_credits_balance=v_nd,expiring_credits=v_ne,
            non_expiring_credits=v_nn,balance=v_nt,updated_at=NOW() WHERE account_id=p_account_id;
          INSERT INTO kortix.credit_ledger(account_id,amount,balance_after,type,description,metadata)
          VALUES(p_account_id,-p_amount,v_nt,'usage',p_description,
            jsonb_build_object('from_daily',v_fd,'from_monthly',v_fe,'from_extra',v_fn,'ledger_type',p_ledger_type))
          RETURNING id INTO v_tid;
          RETURN jsonb_build_object('success',true,'amount_deducted',p_amount,'new_total',v_nt,
            'new_daily',v_nd,'new_expiring',v_ne,'new_non_expiring',v_nn,
            'from_daily',v_fd,'from_monthly',v_fe,'from_extra',v_fn,
            'from_expiring',v_fe,'from_non_expiring',v_fn,'transaction_id',v_tid);
        END;
    $function$;
  $sql$;

  -- Grant EXECUTE to the backend service role only (skip cleanly on a bare local
  -- Postgres that has no Supabase roles, so the function still gets created there).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.atomic_use_credits(uuid,numeric,text,text) FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.atomic_use_credits(uuid,numeric,text,text) TO service_role';
  END IF;

  -- Tell PostgREST to refresh its schema cache so the new signature resolves.
  PERFORM pg_notify('pgrst', 'reload schema');
END $$;
