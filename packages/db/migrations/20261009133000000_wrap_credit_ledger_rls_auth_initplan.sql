-- Migration: wrap_credit_ledger_rls_auth_initplan
--
-- Supabase performance advisor lint `auth_rls_initplan` (WARN, EXTERNAL-facing)
-- on public.credit_ledger (KRTX-1138). The lint is per policy — its cache key
-- is auth_rls_init_plan_<schema>_<table>_<policy> — and both legacy policies
-- of the pre-baseline table call an auth function bare, so Postgres
-- re-evaluates each for every row instead of planning it once per statement
-- (an init plan):
--   "Service role manages ledger" calls auth.role() bare,
--   "Users can view own ledger"  calls auth.uid()  bare.
-- The advisor's own remediation is to wrap each call: `(select auth.role())`.
-- Both policies are rewritten here, as the sibling legacy tables were
-- (audit_log KRTX-1134, public_credit_usage KRTX-1140, user_roles KRTX-1150).
--
-- ALTER POLICY replaces only each policy's USING expression. The role list,
-- command, permissiveness and the implicit (declared-null) WITH CHECK stay
-- exactly as found — on the long-lived databases KRTX-1162 has already scoped
-- the roles to {service_role} and {authenticated}, and this migration keeps
-- whatever it finds. The predicates authorize exactly the same rows; only the
-- plan changes.
--
-- public.credit_ledger is the pre-baseline wallet table (KRTX-1122): the
-- monorepo baseline 20260621094136410 creates only kortix.credit_ledger,
-- whose policies already carry the wrapped form. The legacy twin exists only
-- on environments that predate the baseline and still receives rows. The
-- guards below fire only where the legacy table and its bare per-row
-- predicates survive — the long-lived databases — and are a no-op on fresh
-- installs. An unexpected predicate is left untouched: the migration never
-- rewrites an access rule the advisor did not describe.
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
      AND qual IN (
        '(auth.role() = ''service_role''::text)',
        '(role() = ''service_role''::text)'
      )
  ) THEN
    ALTER POLICY "Service role manages ledger" ON public.credit_ledger
      USING ((select auth.role()) = 'service_role'::text);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'credit_ledger'
      AND policyname = 'Users can view own ledger'
      AND qual IN (
        '(auth.uid() = account_id)',
        '(uid() = account_id)'
      )
  ) THEN
    ALTER POLICY "Users can view own ledger" ON public.credit_ledger
      USING ((select auth.uid()) = account_id);
  END IF;
END
$wrap_credit_ledger_rls_auth_initplan$;
