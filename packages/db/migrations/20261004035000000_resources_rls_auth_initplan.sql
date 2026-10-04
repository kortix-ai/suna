-- Migration: resources_rls_auth_initplan
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The Supabase performance advisor (lint `auth_rls_initplan`, WARN,
-- EXTERNAL-facing) flags `public.resources` (KRTX-1147): all four
-- account-membership policies call `auth.uid()` bare, so Postgres re-evaluates
-- `current_setting()` for every row instead of evaluating it once per statement
-- as an init plan. Supabase's remediation is to wrap the call:
-- `(select auth.uid())`.
--
-- `public.resources` is a retired-Suna (agentpress) table: the baseline never
-- creates it, drizzle models no `public.resources`, and only the Suna
-- account-migration scripts read it
-- (`apps/api/src/scripts/migrate-suna-account.ts`,
-- `apps/api/src/projects/suna-migration/suna-migration-phases.ts`). It survives
-- on the long-lived databases. The guard below makes this a no-op where the
-- table does not exist (fresh installs, CI databases, self-host), and each
-- per-policy guard a no-op where that exact policy is gone: the migration never
-- invents access.
--
-- The rewrite preserves every policy's identity and semantics — same name, role
-- (`public`), command, permissiveness, and the same predicate with only
-- `auth.uid()` wrapped — so what each policy allows is unchanged; only the plan
-- changes from a per-row call to a one-per-statement init plan. The UPDATE
-- policy keeps USING-only: with no explicit WITH CHECK, Postgres applies the
-- USING expression as the implicit check, exactly as the old policy did.

DO $wrap_resources_rls_auth_initplan$
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
        account_id IS NULL OR EXISTS (
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
        account_id IS NULL OR EXISTS (
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
        account_id IS NULL OR EXISTS (
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
      AND policyname = 'Account members can delete resources for their accounts'
  ) THEN
    DROP POLICY "Account members can delete resources for their accounts" ON public.resources;
    CREATE POLICY "Account members can delete resources for their accounts" ON public.resources
      FOR DELETE TO public
      USING (
        EXISTS (
          SELECT 1 FROM basejump.account_user
          WHERE account_user.account_id = resources.account_id
            AND account_user.user_id = (select auth.uid())
        )
      );
  END IF;
END
$wrap_resources_rls_auth_initplan$;
