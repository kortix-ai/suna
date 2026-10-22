-- Migration: checkout_clicks_rls_initplan
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The Supabase performance advisor (lint `auth_rls_initplan`) flags the RLS
-- policy `Users can track their own checkout clicks` on the legacy table
-- `public.checkout_clicks`: both of its expressions call `auth.uid()` bare, so
-- Postgres re-evaluates `current_setting()` for every row instead of evaluating
-- it once per statement as an init plan. Supabase's remediation is to wrap the
-- call: `(select auth.uid())`.
--
-- `public.checkout_clicks` is a retired-Suna table: no Kortix code references
-- it (a git grep over apps/, packages/, infra/, supabase/ and scripts/ finds
-- only the legacy analytics function dropped by 20260924205551453), and
-- baseline databases (local, CI, self-host) built from
-- 20260621094136410_baseline.sql never had it. Everything below is guarded, so
-- a database without the table or without that exact policy is a no-op: the
-- migration never creates a policy that was not already there.
--
-- The rewrite preserves the policy's identity and semantics — same name, role
-- (`public`), command (`ALL`), permissiveness, and both expressions compare the
-- same `auth.uid()` against `user_id` — so what the policy allows is unchanged;
-- only the plan changes from a per-row call to a one-per-statement init plan.

DO $$
BEGIN
  IF to_regclass('public.checkout_clicks') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'checkout_clicks'
      AND policyname = 'Users can track their own checkout clicks'
  ) THEN
    RETURN;
  END IF;

  DROP POLICY "Users can track their own checkout clicks" ON public.checkout_clicks;
  CREATE POLICY "Users can track their own checkout clicks" ON public.checkout_clicks
    USING ((select auth.uid()) = user_id)
    WITH CHECK ((select auth.uid()) = user_id);
END
$$;
