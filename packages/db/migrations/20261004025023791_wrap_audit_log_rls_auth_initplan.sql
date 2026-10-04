-- Migration: wrap_audit_log_rls_auth_initplan
--
-- KRTX-1134. The Supabase performance advisor (lint `auth_rls_initplan`, WARN,
-- EXTERNAL) flags both RLS policies on the legacy table `public.audit_log`:
-- they call `auth.role()` and `auth.uid()` bare, so Postgres re-evaluates them
-- for every row instead of planning them once per statement as an init plan.
-- Supabase's remediation is to wrap each call: `(select auth.role())`.
--
-- The same wrap already cleared the lint on the sibling legacy public tables
-- (KRTX-1130 and follow-ups, 2026-10-02): the live advisor reports api_keys,
-- credit_purchases, checkout_clicks, account_deletion_requests, credit_accounts
-- and public_credit_usage clean, and this table still flagged.
--
-- `public.audit_log` is a pre-baseline legacy table: the monorepo baseline
-- `20260621094136410_baseline.sql` does not create it, no Kortix code
-- references it, and it is empty on the live database — the managed audit
-- surface is `kortix.audit_events`. A baseline-built database (local, CI,
-- self-host) never has it, so everything below is guarded: a database without
-- the table, or without one of these exact policies, is a no-op — the
-- migration never creates a policy that was not already there.
--
-- The rewrite preserves each policy's identity and semantics — same name, role
-- (`public`), command (`ALL` / `SELECT`), permissiveness, and predicates that
-- compare the same `auth.role()` against `'service_role'::text` and the same
-- `auth.uid()` against `account_id` — so what each policy allows is unchanged;
-- only the plan changes from per-row calls to one-per-statement init plans.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.audit_log') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'audit_log'
      AND policyname = 'Service role manages audit log'
  ) THEN
    DROP POLICY "Service role manages audit log" ON public.audit_log;
    CREATE POLICY "Service role manages audit log" ON public.audit_log
      FOR ALL USING ((select auth.role()) = 'service_role'::text);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'audit_log'
      AND policyname = 'Users can view own audit log'
  ) THEN
    DROP POLICY "Users can view own audit log" ON public.audit_log;
    CREATE POLICY "Users can view own audit log" ON public.audit_log
      FOR SELECT USING ((select auth.uid()) = account_id);
  END IF;
END
$$;
