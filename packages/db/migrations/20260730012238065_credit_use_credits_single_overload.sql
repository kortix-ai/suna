-- Migration: credit_use_credits_single_overload
--
-- Collapse public.atomic_use_credits from TWO overloads to ONE, so a
-- four-positional-argument call can never raise 42725 again.
--
-- THE BUG. 20260725010940000_credit_rpc_numeric_precision.sql left both of
-- these live:
--   A  (p_account_id uuid, p_amount numeric, p_description text, p_ledger_type text)
--        4 params, 0 defaults  -> callable with exactly 4 args
--   B  (p_account_id uuid, p_amount numeric, p_description text DEFAULT …,
--        p_thread_id text DEFAULT NULL, p_message_id text DEFAULT NULL)
--        5 params, 3 defaults  -> callable with 2, 3, 4 or 5 args
-- Their callable arities OVERLAP at 4, so
--   select atomic_use_credits($1::uuid, $2::numeric, $3::text, $4::text)
-- fails with
--   ERROR: function public.atomic_use_credits(uuid, numeric, text, text)
--          is not unique   (SQLSTATE 42725)
-- in the money path. Production only escaped it because the busiest caller
-- (apps/api/src/billing/services/credits.ts) uses PostgREST NAMED parameters,
-- which resolve by argument-name set rather than by arity. That was luck.
--
-- B was also the WEAKER function: SECURITY INVOKER (A is SECURITY DEFINER) and
-- it never stamped metadata->>'ledger_type', so every debit that bound it was
-- invisible to the usage breakdown.
--
-- THE END STATE. One function, no overloads at all: A, with DEFAULTs added to
-- p_description and p_ledger_type. That single signature answers every call
-- shape that either overload used to answer:
--   arity 2 / 3   -> was B, now A with p_ledger_type = 'usage'
--   arity 4       -> was AMBIGUOUS, now unambiguously A
--   named 4       -> was A, still A
-- The only shape that stops working is one passing p_thread_id / p_message_id.
-- Nothing does: an exhaustive sweep of apps/**, packages/**, tests/** and
-- infra/** finds those parameter names in exactly one place — an assertion
-- that they are ABSENT (apps/api/src/__tests__/billing/credits.test.ts).
--
-- Also drops the dead 7-argument overload of atomic_grant_renewal_credits,
-- whose callable arity range (5-7) overlaps its 10-argument sibling's (5-10).
-- The debt item this discharges is packages/db/MIGRATIONS.md "Duplicate
-- function overloads". Both overloads have zero callers in any language in the
-- repo, and the 10-argument one is a strict superset — identical first seven
-- parameter names and types, three further defaulted ones — so every call
-- shape the dropped function could serve still resolves.
--
-- mixed-version-safe: old API pods issue `atomic_use_credits($1,$2,$3)` (three
-- positional args, apps/api/src/repositories/credits.ts before this release).
-- That shape KEEPS WORKING after this migration because p_description and
-- p_ledger_type are DEFAULTed, so it binds the surviving function and takes
-- p_ledger_type = 'usage' — byte-identical ledger classification to the
-- overload it used to bind (dropped B wrote no ledger_type at all, and
-- COALESCE(NULLIF(metadata->>'ledger_type',''), type) already resolved those
-- rows to 'usage' via the type column). Old pods therefore see no behaviour
-- change, only a stronger function (SECURITY DEFINER + the balance guard).
-- Dropping atomic_grant_renewal_credits(7-arg) is safe in a mixed version
-- because no deployed code of any version has ever called it.

set lock_timeout = '2s';
set statement_timeout = '30s';

-- 1. Remove the ambiguity source. DROP takes an exclusive lock, so concurrent
--    in-flight calls block until this transaction commits and are then
--    re-planned against the surviving function rather than erroring.
DROP FUNCTION IF EXISTS public.atomic_use_credits(uuid, numeric, text, text, text);

-- 2. Re-assert the canonical function WITH defaults. CREATE OR REPLACE keeps
--    the same identity (name + input argument types), so the existing OID,
--    grants and dependencies are preserved; only pronargdefaults changes
--    (0 -> 2). Body is unchanged from
--    20260725010940000_credit_rpc_numeric_precision.sql.
CREATE OR REPLACE FUNCTION public.atomic_use_credits(
  p_account_id uuid,
  p_amount numeric,
  p_description text DEFAULT 'Credit usage'::text,
  p_ledger_type text DEFAULT 'usage'::text
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

-- CREATE OR REPLACE preserves the ACL, but re-assert it so a database
-- provisioned from packages/db/drizzle/0000_bootstrap.sql (which defines ONLY
-- the dropped 5-argument shape, never the canonical one) ends up granted too.
GRANT EXECUTE ON FUNCTION public.atomic_use_credits(uuid, numeric, text, text)
  TO service_role, authenticated;

-- 3. Same latent ambiguity, dead function: drop the subset overload.
DROP FUNCTION IF EXISTS public.atomic_grant_renewal_credits(
  uuid, bigint, bigint, numeric, text, text, text
);
