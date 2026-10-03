-- Migration: agent_runs_select_policy_initplan
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Catalog-only DDL: no table rewrite. DROP/CREATE POLICY takes an
-- ACCESS EXCLUSIVE lock on agent_runs itself, held to commit; on prod this
-- table only serves legacy PostgREST reads, so the window is brief.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Supabase performance advisor `auth_rls_initplan` on `public.agent_runs`
-- (factory-key: supabase:advisor:auth-rls-initplan:public.agent_runs, KRTX-1131):
-- the RLS policy `agent_runs_select_policy` calls auth.uid() directly in its
-- expression, so Postgres re-evaluates it for every row. auth.uid() is STABLE,
-- so wrapping it in a scalar sub-select turns the call into an InitPlan that
-- runs once per statement — the advisor's own remediation. The filtered rows
-- are unchanged.
--
-- The policy is legacy (it predates the `kortix` schema; the app itself talks
-- to `kortix` with a role that bypasses RLS). Only databases upgraded from the
-- legacy deployment carry `public.agent_runs`, so the rewrite is guarded and
-- runs as a no-op everywhere else. `user_roles` / `user_role` / `basejump`
-- need no guard of their own: a database that has this policy already has the
-- objects its expression references.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'agent_runs'
      AND policyname = 'agent_runs_select_policy'
  ) THEN
    DROP POLICY agent_runs_select_policy ON public.agent_runs;
    CREATE POLICY agent_runs_select_policy ON public.agent_runs
      AS PERMISSIVE FOR SELECT TO public
      USING (
        (
          EXISTS (
            SELECT 1
            FROM threads
            WHERE threads.thread_id = agent_runs.thread_id
              AND (
                threads.is_public = true
                OR threads.account_id = (select auth.uid())
                OR basejump.has_role_on_account(threads.account_id) = true
                OR EXISTS (
                  SELECT 1
                  FROM projects
                  WHERE projects.project_id = threads.project_id
                    AND (
                      projects.is_public = true
                      OR basejump.has_role_on_account(projects.account_id) = true
                    )
                )
              )
          )
          OR EXISTS (
            SELECT 1
            FROM user_roles
            WHERE user_roles.user_id = (select auth.uid())
              AND user_roles.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])
          )
        )
      );
  END IF;
END $$;
