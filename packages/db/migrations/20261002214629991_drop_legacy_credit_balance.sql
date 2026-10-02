-- Migration: drop_legacy_credit_balance
--
-- The Supabase performance advisor reports `auth_rls_initplan` on
-- `public.credit_balance` (KRTX-1137): both of its RLS policies call
-- `auth.role()` / `auth.uid()` per row. The table is a basejump-era leftover
-- that the current product never touches, so the fix is to retire it instead
-- of optimizing policies on a corpse:
--
--   * Not modeled anywhere: packages/db/src/schema/public.ts explicitly moved
--     the credit/billing tables to kortix.ts under the `kortix` schema, and
--     the live wallet is `kortix_wallet.grant_credits` (public.atomic_add_credits
--     delegates to it). A repo-wide grep finds zero references to
--     credit_balance outside this migrations directory.
--   * Baseline databases (fresh local, CI, self-host) never had it: the
--     baseline creates only public.daily_refresh_tracking and
--     public.renewal_processing in `public`, so every statement below is a
--     no-op there. The table exists only in databases that predate the
--     Kortix baseline.
--   * Read-only catalog audit of prod (Management API read-only SQL,
--     2026-10-02): exactly 0 rows, 24 KB total, RLS on, 2 policies
--     ("Service role can manage all credit balances", "Users can view their
--     own credit balance"), no views or materialized views reading it, no
--     inbound foreign keys, no triggers, no pg_cron jobs, no other table's
--     RLS policy and no column default referencing it, and no query against
--     it in pg_stat_statements.
--   * Its last accessor, public.add_credits(uuid, numeric, uuid), is equally
--     dead: 0 calls in pg_stat_statements, referenced by nothing (no
--     pg_depend, cron, other function body or default), and its body inserts
--     into a credit_balance column (user_id) the current table does not have
--     — a call can only fail. Dropping the table without it would leave a
--     SECURITY DEFINER function that fails on its first call, so the same
--     migration removes it, with the same evidence standard as
--     20260924205551453_drop_legacy_public_functions.
--
-- Dropping the table also clears the advisor's other two findings on it:
-- multiple_permissive_policies (KRTX-1161) and unused_index
-- idx_credit_balance_account_id (KRTX-1227).
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Apply-time guard, same standard as 20260924205551453: a dependency that
-- appeared after the audit above fails the migration instead of silently
-- breaking an object. Structural dependents (views, inbound foreign keys)
-- are covered a second time by the plain DROP TABLE below — it has no
-- CASCADE, so any survivor fails loudly instead of being taken down.
DO $$
DECLARE
  blocker text;
BEGIN
  IF to_regclass('public.credit_balance') IS NULL THEN
    RETURN; -- baseline database: nothing to retire
  END IF;

  -- SQL or PL/pgSQL function bodies record no pg_depend row.
  SELECT string_agg(DISTINCT n.nspname || '.' || p.proname, '; ')
    INTO blocker
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND l.lanname IN ('sql', 'plpgsql')
    AND p.prosrc ~ '\mcredit_balance\M'
    AND NOT (n.nspname = 'public' AND p.proname = 'add_credits');
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'public.credit_balance drop refused, a function body still references it: %', blocker;
  END IF;

  -- pg_cron commands are plain text and record no dependency either.
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $q$
      SELECT string_agg(DISTINCT jobname, '; ')
      FROM cron.job
      WHERE command ~* '\mcredit_balance\M|\madd_credits\M'
    $q$ INTO blocker;
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION 'public.credit_balance drop refused, a pg_cron job still references it: %', blocker;
    END IF;
  END IF;

  -- Another table's RLS policy subquery.
  SELECT string_agg(DISTINCT schemaname || '.' || tablename || ' :: ' || policyname, '; ')
    INTO blocker
  FROM pg_policies
  WHERE (qual ~ '\mcredit_balance\M' OR with_check ~ '\mcredit_balance\M')
    AND NOT (schemaname = 'public' AND tablename = 'credit_balance');
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'public.credit_balance drop refused, an RLS policy still references it: %', blocker;
  END IF;

  -- Column defaults.
  SELECT string_agg(DISTINCT n.nspname || '.' || c.relname || '.' || a.attname, '; ')
    INTO blocker
  FROM pg_attrdef ad
  JOIN pg_class c ON c.oid = ad.adrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ad.adnum
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND pg_get_expr(ad.adbin, ad.adrelid) ~ '\mcredit_balance\M|\madd_credits\M';
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'public.credit_balance drop refused, a column default still references it: %', blocker;
  END IF;
END
$$;

DROP TABLE IF EXISTS public.credit_balance;
DROP FUNCTION IF EXISTS public.add_credits(uuid, numeric, uuid);

-- mixed-version-safe: no app version can still be running against these
-- objects. The current codebase has zero references to either name (the
-- retired backend that created them is gone), prod has 0 rows and 0
-- pg_stat_statements calls on the table and 0 calls of the function, and the
-- read-only audit above lists every remaining dependent — none. Baseline
-- databases never had them, so the IF EXISTS forms are no-ops on fresh
-- installs, and the apply-time guard fails closed if a dependent appeared
-- between the audit and this migration's apply.
