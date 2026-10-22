-- Migration: thread_select_auth_initplan
--
-- Supabase performance advisor lint `auth_rls_initplan` (WARN, EXTERNAL-facing)
-- on public.threads: the legacy SELECT policy thread_select_policy calls
-- auth.uid() bare, so Postgres re-evaluates it for every row instead of
-- planning it once per statement (an InitPlan). ALTER POLICY replaces only the
-- USING expression with the advisor's own remediation, (select auth.uid());
-- the policy's roles and command stay untouched, and every predicate keeps
-- authorizing exactly the same rows.
--
-- public.threads is legacy: it predates the monorepo baseline and is created
-- by neither the baseline nor 0000_bootstrap (which creates only
-- kortix.chat_threads). It exists only on the long-lived databases. The guard
-- below makes this migration a no-op on fresh installs and CI databases, and
-- a no-op when the policy is absent (never invent access).
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $thread_select_auth_initplan$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'threads'
      AND policyname = 'thread_select_policy'
  ) THEN
    ALTER POLICY thread_select_policy ON public.threads USING (
      (is_public IS TRUE)
      OR (basejump.has_role_on_account(account_id) = true)
      OR (EXISTS (
        SELECT 1 FROM public.projects
        WHERE projects.project_id = threads.project_id
          AND ((projects.is_public IS TRUE)
            OR (basejump.has_role_on_account(projects.account_id) = true))
      ))
      OR (EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_roles.user_id = (SELECT auth.uid())
          AND user_roles.role = ANY (ARRAY['admin'::public.user_role, 'super_admin'::public.user_role])
      ))
    );
  END IF;
END
$thread_select_auth_initplan$;
