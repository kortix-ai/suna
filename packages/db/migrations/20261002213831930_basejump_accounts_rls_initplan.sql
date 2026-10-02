-- Migration: basejump_accounts_rls_initplan
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The Supabase performance advisor (lint auth_rls_initplan, WARN, EXTERNAL)
-- flags basejump.accounts: its "Accounts are viewable by primary owner" SELECT
-- policy evaluates auth.uid() once per row instead of once per statement.
-- basejump is retired legacy (20260706120000000_retire_basejump): no app code
-- reads or writes the schema, but it survives on environments that predate the
-- baseline, and this policy is still live row-level security on that table.
-- Recreate the same policy with the initplan form (select auth.uid()) --
-- identical predicate, roles and command, evaluated once per statement.
-- Fresh installs have no basejump.accounts (the baseline never creates it and
-- test-prereqs.sql only stubs account_user): the guard makes this a no-op.
DO $$ BEGIN
  IF to_regclass('basejump.accounts') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Accounts are viewable by primary owner" ON basejump.accounts;
    CREATE POLICY "Accounts are viewable by primary owner" ON basejump.accounts
      FOR SELECT TO authenticated
      USING (primary_owner_user_id = (select auth.uid()));
  END IF;
END $$;
