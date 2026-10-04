-- Migration: audit_log_rls_initplan
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Policy DDL only: catalog-level metadata, no table data touched, no table lock
-- beyond the brief one ALTER POLICY takes.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHAT
--
-- The Supabase performance advisor reports `auth_rls_initplan` on
-- `public.audit_log` (WARN, EXTERNAL). Two of the table's policies call
-- `auth.<function>()` bare, so Postgres re-evaluates the call for every row it
-- filters instead of once per statement:
--
--   "Service role manages audit log"  USING (auth.role() = 'service_role'::text)  (ALL)
--   "Users can view own audit log"    USING (auth.uid() = account_id)             (SELECT)
--
-- The fix is the advisor's own remediation (see the lint's detail text):
-- wrap each call in a scalar subquery, `(select auth.<function>())`. The
-- planner evaluates an uncorrelated scalar subquery as an InitPlan -- once per
-- statement -- instead of once per row. The permitted rows do not change: the
-- subqueries are uncorrelated and the functions are STABLE, so every query
-- that passed before passes after.
--
-- `ALTER POLICY` changes only the USING expression. Roles (public), command
-- (ALL / SELECT) and the permissive flag are untouched, and the ALL policy's
-- writes keep falling back to USING (with_check stays NULL).
--
-- WHY THE TABLE IS GUARDED
--
-- `public.audit_log` is a pre-baseline legacy table (id, account_id, category,
-- action, details, ip_address, user_agent, created_at): Kortix code writes
-- audit history to `kortix.audit_events` and no committed migration creates
-- `public.audit_log`. It exists only on the long-lived hosted databases.
-- Guarded by `to_regclass` plus a `pg_policies` check per policy, every
-- statement is a no-op where the table or a policy is absent (never invent
-- access), and the migration re-runs cleanly.

DO $audit_log_rls_initplan$
BEGIN
  IF to_regclass('public.audit_log') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policy pol
      JOIN pg_class cls ON cls.oid = pol.polrelid
     WHERE cls.relnamespace = 'public'::regnamespace
       AND cls.relname = 'audit_log'
       AND pol.polname = 'Service role manages audit log'
  ) THEN
    EXECUTE $p$ALTER POLICY "Service role manages audit log" ON public.audit_log
      USING ((select auth.role()) = 'service_role'::text)$p$;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policy pol
      JOIN pg_class cls ON cls.oid = pol.polrelid
     WHERE cls.relnamespace = 'public'::regnamespace
       AND cls.relname = 'audit_log'
       AND pol.polname = 'Users can view own audit log'
  ) THEN
    EXECUTE $p$ALTER POLICY "Users can view own audit log" ON public.audit_log
      USING ((select auth.uid()) = account_id)$p$;
  END IF;
END
$audit_log_rls_initplan$;
