-- Migration: wallet_private_schema
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Function and schema DDL only: no table is altered, so no table lock is taken.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHAT
--
-- The wallet's SQL functions move out of `public` into `kortix_wallet`, a
-- schema that PostgREST does not expose and that no client role can use. The
-- API module `apps/api/src/billing/wallet` is the only caller:
--
--   kortix_wallet.grant_credits           <- public.atomic_add_credits
--   kortix_wallet.debit_credits           <- public.atomic_use_credits     (p_enforce_floor => true)
--                                            public.atomic_settle_credits  (p_enforce_floor => false)
--   kortix_wallet.reset_expiring_credits  <- public.atomic_reset_expiring_credits
--
-- `atomic_use_credits` (ADMISSION) and `atomic_settle_credits` (SETTLEMENT)
-- were one function body twice; the only difference was the balance floor and
-- the `overdraft` flag. `debit_credits` is that body once, with the floor as a
-- parameter. A NULL floor enforces it (fail closed).
--
-- The bodies are the current definitions (grant: 20260725010940000; debit:
-- 20260805175409752 + 20260901190128060; reset: the baseline), with one change:
-- `grant_credits` checks a request key against the whole ledger, where
-- `atomic_add_credits` looked back one hour. The wallet already enforced the
-- whole-ledger rule in its own query (#7624); it now lives in SQL.
--
-- The new functions are SECURITY INVOKER. Only the API role can execute them,
-- and that role already writes both tables directly (the wallet's `forfeit`,
-- and `atomic_add_credits`, which was always INVOKER).
--
-- MIXED VERSION
--
-- The API image that runs while this migration applies still calls
-- `public.atomic_*`. Those four names stay, as thin wrappers with unchanged
-- signatures, defaults, security mode and grants, that delegate to
-- `kortix_wallet`. So old and new API pods write identical rows.
-- FOLLOW-UP (next release): drop the wrappers once no deployed image calls them.
-- The migration is parked in
-- packages/db/migrations-pending/drop_public_wallet_wrappers.sql.pending.
--
-- `atomic_daily_credit_refresh` and `atomic_grant_renewal_credits` are dropped,
-- not moved. No code calls them.
--
-- mixed-version-safe: the four wallet names keep their signatures and delegate to the new functions, so a pre-rollout pod writes the same rows. The two dropped functions have no caller: git grep over apps/, packages/, scripts/ and infra/ finds none, and a read-only check of dev, staging and prod on 2026-09-25 found no pg_cron command and no function body that references them. The guard below repeats that check at apply time.

CREATE SCHEMA kortix_wallet;
COMMENT ON SCHEMA kortix_wallet IS
  'The credit wallet''s SQL functions. Private: only the API role may use it. Called by apps/api/src/billing/wallet.';
REVOKE ALL ON SCHEMA kortix_wallet FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA kortix_wallet REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ─── grant ───────────────────────────────────────────────────────────────────

CREATE FUNCTION kortix_wallet.grant_credits(
  p_account_id uuid,
  p_amount numeric,
  p_is_expiring boolean,
  p_description text,
  p_expires_at timestamp with time zone,
  p_type text,
  p_stripe_event_id text,
  p_idempotency_key text
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

  -- A key applies once for the life of the ledger. Two concurrent grants can
  -- both pass this check; the unique index on credit_ledger.idempotency_key
  -- then refuses the second insert, and the wallet reports it as a replay.
  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1
    FROM kortix.credit_ledger
    WHERE idempotency_key = p_idempotency_key
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

-- ─── debit: admission (floor) and settlement (no floor) ─────────────────────

CREATE FUNCTION kortix_wallet.debit_credits(
  p_account_id uuid,
  p_amount numeric,
  p_enforce_floor boolean,
  p_description text,
  p_ledger_type text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
  -- ADMISSION ("may this account start work?") refuses what the balance cannot
  -- cover. SETTLEMENT ("record work already done") always records, and the
  -- remainder may take the non-expiring bucket below zero.
  v_floor boolean := p_enforce_floor IS NOT FALSE;
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
  v_settlement jsonb;
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

  -- Replay check. AFTER the FOR UPDATE, so a concurrent debit for the same
  -- account cannot slip between the lookup and the insert. BEFORE the floor, so
  -- a replay succeeds even once the wallet has since been drained: the money
  -- for this key already moved, and a failure would make the caller charge it
  -- again.
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

  IF v_floor AND v_total < p_amount THEN
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
  -- The remainder lands in the non-expiring bucket. Under the floor it always
  -- fits; for a settlement it may take this bucket negative.
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

  -- A settlement row and result carry `overdraft`, so the overdrawn population
  -- is one query away. An admission row never overdraws and never carried it.
  v_settlement := CASE WHEN v_floor THEN '{}'::jsonb ELSE jsonb_build_object('overdraft', v_nt < 0) END;

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
    ) || v_settlement,
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
  ) || v_settlement;
END;
$function$;

-- ─── reset (new billing period) ─────────────────────────────────────────────

-- The baseline body, unchanged: it still reads and writes the 2-decimal legacy
-- columns, and the precision-sync trigger copies them into the *_precise ones.
CREATE FUNCTION kortix_wallet.reset_expiring_credits(
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
    v_current_balance NUMERIC(10, 2);
    v_current_expiring NUMERIC(10, 2);
    v_current_non_expiring NUMERIC(10, 2);
    v_actual_non_expiring NUMERIC(10, 2);
    v_new_total NUMERIC(10, 2);
    v_expires_at TIMESTAMP WITH TIME ZONE;
BEGIN
    SELECT balance, expiring_credits, non_expiring_credits
    INTO v_current_balance, v_current_expiring, v_current_non_expiring
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
        expiring_credits = p_new_credits,
        non_expiring_credits = v_actual_non_expiring,
        balance = v_new_total,
        updated_at = NOW()
    WHERE account_id = p_account_id;

    INSERT INTO kortix.credit_ledger (
        account_id, amount, balance_after, type, description,
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

-- ─── privileges ─────────────────────────────────────────────────────────────

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kortix_wallet FROM PUBLIC;

-- The API connects as the owner (postgres). service_role is the other role the
-- public.atomic_* functions were granted to; it keeps the same reach.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT USAGE ON SCHEMA kortix_wallet TO service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA kortix_wallet TO service_role;
  END IF;
END
$$;

-- ─── public.atomic_* compatibility wrappers (one release) ───────────────────
--
-- CREATE OR REPLACE keeps each function's owner and ACL. Signatures, defaults
-- and SECURITY mode are unchanged from the definitions they replace.

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
LANGUAGE sql
SET search_path TO ''
AS $function$
  SELECT kortix_wallet.grant_credits(
    p_account_id => p_account_id,
    p_amount => p_amount,
    p_is_expiring => p_is_expiring,
    p_description => p_description,
    p_expires_at => p_expires_at,
    p_type => p_type,
    p_stripe_event_id => p_stripe_event_id,
    p_idempotency_key => p_idempotency_key
  )
$function$;

CREATE OR REPLACE FUNCTION public.atomic_use_credits(
  p_account_id uuid,
  p_amount numeric,
  p_description text DEFAULT 'Credit usage'::text,
  p_ledger_type text DEFAULT 'usage'::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT kortix_wallet.debit_credits(
    p_account_id => p_account_id,
    p_amount => p_amount,
    p_enforce_floor => true,
    p_description => p_description,
    p_ledger_type => p_ledger_type,
    p_idempotency_key => p_idempotency_key
  )
$function$;

CREATE OR REPLACE FUNCTION public.atomic_settle_credits(
  p_account_id uuid,
  p_amount numeric,
  p_description text DEFAULT 'Credit settlement'::text,
  p_ledger_type text DEFAULT 'usage'::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT kortix_wallet.debit_credits(
    p_account_id => p_account_id,
    p_amount => p_amount,
    p_enforce_floor => false,
    p_description => p_description,
    p_ledger_type => p_ledger_type,
    p_idempotency_key => p_idempotency_key
  )
$function$;

CREATE OR REPLACE FUNCTION public.atomic_reset_expiring_credits(
  p_account_id uuid,
  p_new_credits numeric,
  p_description text DEFAULT 'Monthly credit renewal'::text,
  p_stripe_event_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE sql
SET search_path TO ''
AS $function$
  SELECT kortix_wallet.reset_expiring_credits(
    p_account_id => p_account_id,
    p_new_credits => p_new_credits,
    p_description => p_description,
    p_stripe_event_id => p_stripe_event_id
  )
$function$;

-- A no-op wherever 20260924194804787 ran; it keeps this file self-contained.
REVOKE EXECUTE ON FUNCTION public.atomic_add_credits(uuid, numeric, boolean, text, timestamp with time zone, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.atomic_use_credits(uuid, numeric, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.atomic_settle_credits(uuid, numeric, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.atomic_reset_expiring_credits(uuid, numeric, text, text) FROM PUBLIC;

-- ─── dead credit functions ──────────────────────────────────────────────────

DO $$
DECLARE
  blocker text;
BEGIN
  -- A function body or a pg_cron command that calls a function records no
  -- dependency, so DROP FUNCTION would succeed and leave the caller broken.
  SELECT string_agg(DISTINCT format('%s.%s', n.nspname, p.proname), ', ') INTO blocker
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND p.proname NOT IN ('atomic_daily_credit_refresh', 'atomic_grant_renewal_credits')
    AND p.prosrc ~ '\matomic_(daily_credit_refresh|grant_renewal_credits)\M';
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'dead credit function drop refused, still called by: %', blocker;
  END IF;

  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $q$
      SELECT string_agg(jobname, ', ') FROM cron.job
      WHERE command ~ '\matomic_(daily_credit_refresh|grant_renewal_credits)\M'
    $q$ INTO blocker;
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION 'dead credit function drop refused, still called by pg_cron job: %', blocker;
    END IF;
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.atomic_daily_credit_refresh(uuid, numeric, text, text, integer);
DROP FUNCTION IF EXISTS public.atomic_grant_renewal_credits(uuid, bigint, bigint, numeric, text, text, text, text, text, text);

-- ─── post-condition ─────────────────────────────────────────────────────────

-- Fail the migration rather than leave a client role able to reach a wallet
-- function, in either schema.
DO $$
DECLARE
  leaked text;
BEGIN
  SELECT string_agg(DISTINCT format('%s on %s', r.rolname, p.oid::regprocedure), '; ') INTO leaked
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) r
  WHERE (n.nspname = 'kortix_wallet' OR (n.nspname = 'public' AND p.proname LIKE 'atomic\_%'))
    AND has_function_privilege(r.rolname, p.oid, 'EXECUTE');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'client roles can execute wallet functions: %', leaked;
  END IF;

  SELECT string_agg(rolname, ', ') INTO leaked
  FROM pg_roles
  WHERE rolname IN ('anon', 'authenticated')
    AND has_schema_privilege(rolname, 'kortix_wallet', 'USAGE');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'client roles can use schema kortix_wallet: %', leaked;
  END IF;
END
$$;
