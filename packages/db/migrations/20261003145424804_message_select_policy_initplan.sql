-- Migration: message_select_policy_initplan
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Supabase performance advisor (auth_rls_initplan, WARN, external) flags
-- `public.messages`: the `message_select_policy` policy evaluates
-- auth.uid() once per row instead of once per statement. public.messages is a
-- legacy (suna -> Kortix cutover) table, ~107 GB in prod, still read by the
-- account-migration tooling (scripts/legacy-transfer, scripts/migrate-suna-account).
--
-- The rewrite is metadata-only: no table rewrite, no data change, same
-- expression, same roles. Only the two auth.uid() calls are wrapped in
-- (select auth.uid()) initplans -- exactly the advisor's prescribed remediation.
-- Dropping and recreating the policy in one transaction means a concurrent
-- reader sees either the old or the new policy, never none.
--
-- Environments that never carried the legacy public tables (fresh baseline
-- builds hold only kortix.*) skip: the objects are absent there, so there is
-- nothing for the advisor to report.

DO $$
BEGIN
  IF to_regclass('public.messages') IS NULL
     OR to_regclass('public.threads') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.user_roles') IS NULL
     OR to_regprocedure('basejump.has_role_on_account(uuid, basejump.account_role)') IS NULL
     OR to_regtype('public.user_role') IS NULL THEN
    RAISE NOTICE 'legacy public.messages surface absent; policy rewrite skipped';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS message_select_policy ON public.messages;
  CREATE POLICY message_select_policy ON public.messages
    AS PERMISSIVE
    FOR SELECT
    TO public
    USING (
      (
        EXISTS (
          SELECT 1
          FROM threads
          LEFT JOIN projects ON threads.project_id = projects.project_id
          WHERE threads.thread_id = messages.thread_id
            AND (
              (threads.is_public IS TRUE)
              OR (threads.account_id = (select auth.uid()))
              OR (basejump.has_role_on_account(threads.account_id) = true)
              OR (
                EXISTS (
                  SELECT 1
                  FROM projects
                  WHERE projects.project_id = threads.project_id
                    AND (
                      (projects.is_public IS TRUE)
                      OR (basejump.has_role_on_account(projects.account_id) = true)
                    )
                )
              )
            )
        )
      )
      OR (
        EXISTS (
          SELECT 1
          FROM user_roles
          WHERE (user_roles.user_id = (select auth.uid()))
            AND (user_roles.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))
        )
      )
    );
END
$$;
