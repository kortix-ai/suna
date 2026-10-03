-- Migration: credit_accounts_rls_initplan
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Policy DDL only: catalog-level metadata, no table data touched, no table lock
-- beyond the brief one ALTER POLICY takes.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHAT
--
-- The Supabase performance advisor reports `auth_rls_initplan` on
-- `public.credit_accounts` (WARN, EXTERNAL). Two of the table's policies call
-- `auth.<function>()` bare, so Postgres re-evaluates the call for every row it
-- filters instead of once per statement:
--
--   "Service role manages credit accounts"  USING (auth.role() = 'service_role')
--   "Users can view own credit account"     USING (auth.uid() = account_id)
--
-- The fix is the advisor's own remediation (see the lint's detail text):
-- wrap each call in a scalar subquery, `(select auth.<function>())`. The
-- planner evaluates an uncorrelated scalar subquery as an InitPlan -- once per
-- statement -- instead of once per row. The permitted rows do not change: the
-- subquery is uncorrelated and the functions are STABLE, so every query that
-- passed before passes after.
--
-- `ALTER POLICY` changes only the expression. Roles (`public`), command (ALL /
-- SELECT) and the permissive flag are untouched.
--
-- WHY THE TABLE IS GUARDED
--
-- `public.credit_accounts` is the retired Suna wallet table: Kortix code writes
-- `kortix.credit_accounts` and never reads this one through PostgREST. It is
-- still alive on the hosted databases, though -- the pg_cron job
-- `yearly-plan-monthly-refill` calls `public.process_monthly_refills()`, which
-- writes it daily (it is why 20260924205551453 kept those functions). So the
-- policies must keep granting exactly what they granted, and the table stays.
-- Baseline databases (local, CI, self-host) never had the table. Guarded by
-- `to_regclass` plus a `pg_policies` check per policy, every statement is a
-- no-op where the table or a policy is absent, and the migration re-runs
-- cleanly.

DO $$
BEGIN
  IF to_regclass('public.credit_accounts') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policy pol
      JOIN pg_class cls ON cls.oid = pol.polrelid
     WHERE cls.relnamespace = 'public'::regnamespace
       AND cls.relname = 'credit_accounts'
       AND pol.polname = 'Service role manages credit accounts'
  ) THEN
    EXECUTE $p$ALTER POLICY "Service role manages credit accounts" ON public.credit_accounts
      USING ((select auth.role()) = 'service_role'::text)$p$;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policy pol
      JOIN pg_class cls ON cls.oid = pol.polrelid
     WHERE cls.relnamespace = 'public'::regnamespace
       AND cls.relname = 'credit_accounts'
       AND pol.polname = 'Users can view own credit account'
  ) THEN
    EXECUTE $p$ALTER POLICY "Users can view own credit account" ON public.credit_accounts
      USING ((select auth.uid()) = account_id)$p$;
  END IF;
END
$$;
