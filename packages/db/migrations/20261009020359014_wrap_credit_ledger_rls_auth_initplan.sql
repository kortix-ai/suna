-- Migration: wrap_credit_ledger_rls_auth_initplan
--
-- Supabase performance advisor lint `auth_rls_initplan` (WARN, EXTERNAL-facing)
-- on public.credit_ledger (KRTX-1138): the legacy policy "Service role manages
-- ledger" calls auth.role() bare, so Postgres re-evaluates it for every row
-- instead of planning it once per statement (an InitPlan). ALTER POLICY
-- replaces only the USING expression with the advisor's own remediation,
-- (select auth.role()). Roles, command, permissiveness and the implicit WITH
-- CHECK stay untouched, and the predicate authorizes exactly the same rows.
--
-- public.credit_ledger is the pre-baseline wallet table (KRTX-1122): the
-- monorepo baseline 20260621094136410 creates only kortix.credit_ledger, whose
-- "Service role manages ledger" policy already carries the wrapped form. The
-- legacy twin exists only on environments that predate the baseline and still
-- receives rows. The guard below fires only where the legacy table and its
-- bare per-row predicate survive — the long-lived databases — and is a no-op
-- on fresh installs. An unexpected predicate is left untouched: the migration
-- never rewrites an access rule the advisor did not describe.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $wrap_credit_ledger_rls_auth_initplan$
BEGIN
  IF to_regclass('public.credit_ledger') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'credit_ledger'
      AND policyname = 'Service role manages ledger'
      -- The legacy per-row predicate the long-lived databases still carry
      -- (prod pg_policies, read-only, 2026-10-03: cmd ALL, roles {public},
      -- with_check NULL). pg_get_expr reprints the predicate at read time and
      -- drops the auth. prefix when auth is on the reader's search_path, so
      -- match both printings exactly and leave every other shape — including
      -- the baseline's wrapped form — untouched.
      AND qual IN (
        '(auth.role() = ''service_role''::text)',
        '(role() = ''service_role''::text)'
      )
  ) THEN
    ALTER POLICY "Service role manages ledger" ON public.credit_ledger
      USING ((select auth.role()) = 'service_role'::text);
  END IF;
END
$wrap_credit_ledger_rls_auth_initplan$;
