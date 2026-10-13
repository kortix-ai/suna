-- Migration: renewal_processing_rls_initplan
--
-- Supabase performance advisor lint `auth_rls_initplan` (WARN, EXTERNAL-facing)
-- on public.renewal_processing (KRTX-1146): the legacy policy "Service role full
-- access on renewal_processing" calls auth.role() bare, so Postgres re-evaluates
-- it for every row instead of planning it once per statement (an InitPlan).
-- ALTER POLICY replaces only the USING expression with the advisor's own
-- remediation, (select auth.role()). Roles, command, permissiveness and the
-- implicit WITH CHECK stay untouched, and the predicate authorizes exactly the
-- same rows.
--
-- public.renewal_processing exists on every database (baseline
-- 20260621094136410), but the baseline already creates this policy wrapped, so
-- the guard below fires only where the legacy per-row predicate survives — the
-- long-lived databases — and is a no-op on fresh installs.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $renewal_processing_rls_initplan$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'renewal_processing'
      AND policyname = 'Service role full access on renewal_processing'
      -- The legacy per-row predicate the long-lived databases still carry
      -- (prod pg_policies, read-only, 2026-10-04: cmd ALL, roles {public},
      -- with_check NULL). pg_get_expr reprints the predicate at read time and
      -- drops the auth. prefix when auth is on the reader's search_path, so
      -- match both printings exactly and leave every other shape — including
      -- the baseline's wrapped form — untouched.
      AND qual IN (
        '(auth.role() = ''service_role''::text)',
        '(role() = ''service_role''::text)'
      )
  ) THEN
    ALTER POLICY "Service role full access on renewal_processing" ON public.renewal_processing
      USING ((select auth.role()) = 'service_role'::text);
  END IF;
END
$renewal_processing_rls_initplan$;
