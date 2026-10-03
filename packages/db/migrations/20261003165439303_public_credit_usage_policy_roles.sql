-- Migration: public_credit_usage_policy_roles
--
-- KRTX-1164 — Supabase performance advisor lint `multiple_permissive_policies`
-- on `public.credit_usage` (WARN, EXTERNAL): the table carries two permissive
-- policies, and both apply to every role:
--
--   "Service role can manage all credit usage"   FOR ALL     roles={public}
--   "Users can view their own credit usage"      FOR SELECT  roles={public}
--
-- The lint groups pg_policies by (table, role, action), expanding FOR ALL to
-- all four actions, so every role's SELECT group holds both policies. Supabase
-- runs the lint on its hosted databases (supabase/splinter
-- lints/0006_multiple_permissive_policies.sql); the prod advisor reported the
-- table under this lint on 2026-10-02.
--
-- THE FIX — scope each policy to the only role its predicate can pass. The
-- lint's end state is one permissive policy per (role, action); giving the two
-- policies disjoint role lists reaches it without touching a predicate:
--
--   ALTER POLICY "Service role can manage all credit usage" ... TO service_role;
--   ALTER POLICY "Users can view their own credit usage"    ... TO authenticated;
--
-- The advisor's docs allow more than one policy per table when consolidating
-- them would blur their meaning ("While consolidating RLS policies ... is a
-- best practice, it is not a hard rule"), and consolidation is the wrong tool
-- here: one policy covering both predicates would have to be FOR ALL — which
-- grants matching users write access they never had — or FOR SELECT — which
-- drops the service role's write access to the legacy table. Role scoping
-- changes neither.
--
-- WHY THE ACCESS DOES NOT CHANGE — on the Supabase surface RLS is evaluated
-- for the role PostgREST switches to, which it takes from the same JWT claim
-- that auth.role() reads, so "current role" and auth.role() agree in every
-- reachable session:
--   authenticated: the user policy is the only one that can pass
--     (auth.uid() = account_id); the service policy never granted these
--     sessions anything (auth.role() = 'authenticated').
--   service_role: the service policy is the only one that can pass
--     (auth.role() = 'service_role'); the user policy never granted these
--     sessions anything (auth.uid() is null — the service JWT carries no sub).
--   anon: both predicates were false (uid null, role 'anon'); now no policy
--     targets anon at all. Same rows.
--   Direct connections (the API's postgres role) bypass RLS or fail both
--     predicates as before; nothing in the repository sets the
--     request.jwt.claim.* GUCs, so no non-service_role session ever passed the
--     service policy's predicate. The quals are untouched, so the InitPlan
--     wrapping KRTX-1140 put in place (20261002214601090) is preserved.
--
-- WHY THE TABLE IS GUARDED — public.credit_usage is a pre-baseline legacy
-- table: the managed surface is kortix.credit_usage (baseline
-- 20260621094136410), fresh databases never create the public one, and no app
-- code references it. The to_regclass guard makes this migration a no-op
-- there, and the per-policy pg_policies check guards prod drift (ALTER POLICY
-- has no IF EXISTS): a missing policy is skipped, not an error.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Policy DDL only: catalog-level metadata, no table data touched, no table
-- lock beyond the brief one ALTER POLICY takes.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.credit_usage') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policy pol
      JOIN pg_class cls ON cls.oid = pol.polrelid
     WHERE cls.relnamespace = 'public'::regnamespace
       AND cls.relname = 'credit_usage'
       AND pol.polname = 'Service role can manage all credit usage'
  ) THEN
    ALTER POLICY "Service role can manage all credit usage" ON public.credit_usage
      TO service_role;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policy pol
      JOIN pg_class cls ON cls.oid = pol.polrelid
     WHERE cls.relnamespace = 'public'::regnamespace
       AND cls.relname = 'credit_usage'
       AND pol.polname = 'Users can view their own credit usage'
  ) THEN
    ALTER POLICY "Users can view their own credit usage" ON public.credit_usage
      TO authenticated;
  END IF;
END
$$;
