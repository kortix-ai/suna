-- Migration: project_select_auth_initplan
--
-- Supabase performance advisor lint `auth_rls_initplan` (WARN, EXTERNAL-facing)
-- on public.projects: the legacy SELECT policy project_select_policy calls
-- auth.uid() bare inside its user_roles administrator lookup, so Postgres
-- re-evaluates it for every row instead of planning it once per statement (an
-- InitPlan). ALTER POLICY replaces only the USING expression with the
-- advisor's own remediation, (select auth.uid()); the policy's command and
-- roles stay untouched, and every predicate keeps authorizing exactly the
-- same rows.
--
-- public.projects is legacy: it predates the monorepo baseline (which creates
-- kortix.projects) and is created by neither the baseline nor 0000_bootstrap.
-- It exists only on the long-lived databases. The guard below makes this
-- migration a no-op on fresh installs and CI databases, and a no-op when the
-- policy is absent (never invent access).
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $project_select_auth_initplan$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'projects'
      AND policyname = 'project_select_policy'
  ) THEN
    ALTER POLICY project_select_policy ON public.projects USING (
      (is_public = true)
      OR (basejump.has_role_on_account(account_id) = true)
      OR (EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_roles.user_id = (SELECT auth.uid())
          AND user_roles.role = ANY (ARRAY['admin'::public.user_role, 'super_admin'::public.user_role])
      ))
    );
  END IF;
END
$project_select_auth_initplan$;
