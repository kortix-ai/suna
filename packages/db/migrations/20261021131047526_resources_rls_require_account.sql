-- Migration: resources_rls_require_account
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- KRTX-2779 (pentest, hardening): the SELECT, UPDATE and INSERT membership
-- policies on `public.resources` admit a row with `account_id IS NULL` to every
-- authenticated principal. The DELETE policy never had that branch, which marks
-- it as an artifact, not intent. Each policy now requires an account match.
--
-- `public.resources` is a retired-Suna (agentpress) table (see
-- 20261004173001004_resources_rls_auth_initplan.sql): the baseline never creates
-- it and drizzle models no `public.resources`. No tracked code reads it since
-- #9360 retired the Suna migration chain; the service role bypasses RLS in any
-- case. Tightening the policies removes access nothing in this product uses.
-- The guards make this a no-op where the table or a policy does not exist
-- (fresh installs, CI, self-host). Each policy keeps its name, role, command and
-- permissiveness; only the `account_id IS NULL OR` admission is gone.
--
-- mixed-version-safe: only RLS policies of a table no deployed code reads under RLS are dropped and recreated in one transaction; no column, constraint or index changes.

DO $resources_rls_require_account$
BEGIN
  IF to_regclass('public.resources') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'resources'
      AND policyname = 'Account members can view resources for their accounts'
  ) THEN
    DROP POLICY "Account members can view resources for their accounts" ON public.resources;
    CREATE POLICY "Account members can view resources for their accounts" ON public.resources
      FOR SELECT TO public
      USING (
        EXISTS (
          SELECT 1 FROM basejump.account_user
          WHERE account_user.account_id = resources.account_id
            AND account_user.user_id = (select auth.uid())
        )
      );
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'resources'
      AND policyname = 'Account members can update resources for their accounts'
  ) THEN
    DROP POLICY "Account members can update resources for their accounts" ON public.resources;
    CREATE POLICY "Account members can update resources for their accounts" ON public.resources
      FOR UPDATE TO public
      USING (
        EXISTS (
          SELECT 1 FROM basejump.account_user
          WHERE account_user.account_id = resources.account_id
            AND account_user.user_id = (select auth.uid())
        )
      );
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'resources'
      AND policyname = 'Account members can insert resources for their accounts'
  ) THEN
    DROP POLICY "Account members can insert resources for their accounts" ON public.resources;
    CREATE POLICY "Account members can insert resources for their accounts" ON public.resources
      FOR INSERT TO public
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM basejump.account_user
          WHERE account_user.account_id = resources.account_id
            AND account_user.user_id = (select auth.uid())
        )
      );
  END IF;
END
$resources_rls_require_account$;
