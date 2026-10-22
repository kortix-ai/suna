-- Migration: wrap_api_keys_rls_auth_initplan
--
-- Supabase performance advisor lint `auth_rls_initplan` (WARN, EXTERNAL-facing)
-- on public.api_keys: the RLS policy "Users can manage their own API keys"
-- calls auth.uid() bare, so Postgres re-evaluates it for every row instead of
-- planning it once per statement (an InitPlan). This replaces the policy with
-- the advisor's own remediation: wrap the call in (select auth.uid()).
--
-- The expression stays semantically identical — same predicate, same rows —
-- only the evaluation shape changes (per-row call → one-time InitPlan). It is
-- the same shape the 2026-07-06 retire_basejump migration already used for the
-- credit-table policies, and it matches the policy forms Supabase's linter
-- accepts on this database today (every bare auth.*() policy is flagged; every
-- (select auth.*()) policy passes).
--
-- public.api_keys is legacy: it predates the monorepo baseline and is created
-- by neither the baseline nor 0000_bootstrap (drizzle excludes it — "managed
-- externally"). It exists only on the long-lived databases. The guard below
-- makes this migration a no-op on fresh installs and CI databases, and a
-- no-op when the policy has already been dropped (never invent access).
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $wrap_api_keys_rls_auth_initplan$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'api_keys'
      AND policyname = 'Users can manage their own API keys'
  ) THEN
    DROP POLICY "Users can manage their own API keys" ON public.api_keys;
    CREATE POLICY "Users can manage their own API keys" ON public.api_keys
      USING (
        account_id IN (
          SELECT wu.account_id
          FROM basejump.account_user wu
          WHERE wu.user_id = (SELECT auth.uid())
        )
      );
  END IF;
END
$wrap_api_keys_rls_auth_initplan$;
