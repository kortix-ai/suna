-- Migration: public_credit_usage_rls_initplan
--
-- KRTX-1140 — Supabase performance advisor lint `auth_rls_initplan` on
-- `public.credit_usage`: the two policies call auth.uid() / auth.role()
-- directly, so Postgres re-evaluates them for every row. Wrapping the call in
-- a scalar subquery turns it into a one-shot InitPlan (the advisor's own
-- remediation: replace auth.<function>() with (select auth.<function>())).
--
-- The statement is wrapped, not removed, so the policy's access semantics are
-- byte-for-byte identical before and after — only the evaluation plan changes.
--
-- public.credit_usage is a pre-baseline legacy table: the managed surface is
-- kortix.credit_usage (see the 20260621094136410_baseline header), fresh
-- databases never create the public one, and no app code references it. Every
-- statement below is therefore guarded on to_regclass so the migration also
-- applies cleanly on a fresh database.
--
-- mixed-version-safe: drop+create of a policy is one atomic transaction with
-- identical semantics; app code never references RLS policies by name, so no
-- old app version can observe the window.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.credit_usage') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Users can view their own credit usage" ON public.credit_usage;
    CREATE POLICY "Users can view their own credit usage" ON public.credit_usage
      FOR SELECT
      USING ((select auth.uid()) = account_id);

    DROP POLICY IF EXISTS "Service role can manage all credit usage" ON public.credit_usage;
    CREATE POLICY "Service role can manage all credit usage" ON public.credit_usage
      USING ((select auth.role()) = 'service_role'::text);
  END IF;
END $$;
