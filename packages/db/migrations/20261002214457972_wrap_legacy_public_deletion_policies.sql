-- Migration: wrap_legacy_public_deletion_policies
--
-- KRTX-1130. The Supabase performance advisor (lint auth_rls_initplan) flags both
-- RLS policies on public.account_deletion_requests: they call auth.role() and
-- auth.uid() bare, so Postgres re-evaluates them for every row. The advisor's
-- remediation wraps each call in (select ...) so it becomes an InitPlan evaluated
-- once per statement. Every sibling service-role policy the baseline captured on
-- the credit tables already has this shape; the two on this table do not.
--
-- public.account_deletion_requests is a pre-baseline legacy copy. The managed
-- surface (baseline 20260621094136410) models account_deletion_requests in the
-- kortix schema only, so a fresh database (local, CI, self-host) never has the
-- public table: the to_regclass guard below makes this migration a no-op there.
-- On databases that predate the baseline it recreates the two policies with
-- identical commands, roles and predicates - only the auth.* calls are wrapped -
-- so access semantics do not change.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.account_deletion_requests') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Service role can manage deletion requests" ON public.account_deletion_requests;
    DROP POLICY IF EXISTS "Users can view their own deletion requests" ON public.account_deletion_requests;
    CREATE POLICY "Service role can manage deletion requests" ON public.account_deletion_requests
      USING ((select auth.role()) = 'service_role'::text);
    CREATE POLICY "Users can view their own deletion requests" ON public.account_deletion_requests
      FOR SELECT USING ((select auth.uid()) = user_id);
  END IF;
END
$$;
