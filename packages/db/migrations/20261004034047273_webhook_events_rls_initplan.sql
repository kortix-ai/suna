-- Migration: webhook_events_rls_initplan
--
-- Supabase performance advisor lint `auth_rls_initplan` (WARN, EXTERNAL-facing)
-- on public.webhook_events: the legacy policy "Service role full access on
-- webhook_events" calls auth.role() bare, so Postgres re-evaluates it for
-- every row it filters instead of planning it once per statement (an
-- InitPlan). The table is large on the hosted databases, so every
-- anon/authenticated scan pays a per-row current_setting() call and still
-- returns zero rows. ALTER POLICY replaces only the USING expression with the
-- advisor's own remediation, (select auth.role()): the planner evaluates an
-- uncorrelated scalar subquery as an InitPlan, once per statement. The
-- policy's roles, command, permissiveness and implicit WITH CHECK stay
-- untouched, and the predicate keeps authorizing exactly the same rows (the
-- subquery is uncorrelated and auth.role() is STABLE).
--
-- public.webhook_events is legacy: it predates the monorepo baseline and is
-- created by neither the baseline nor any later migration (the repo's own
-- webhook dedupe table is kortix.stripe_webhook_events_processed). It exists
-- only on the long-lived databases. The guard below makes this migration a
-- no-op on fresh installs and CI databases, and a no-op when the policy is
-- absent (never invent access).
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Policy DDL only: catalog-level metadata, no table data touched, no table
-- lock beyond the brief one ALTER POLICY takes.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $webhook_events_rls_initplan$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'webhook_events'
      AND policyname = 'Service role full access on webhook_events'
  ) THEN
    ALTER POLICY "Service role full access on webhook_events" ON public.webhook_events
      USING ((select auth.role()) = 'service_role'::text);
  END IF;
END
$webhook_events_rls_initplan$;
