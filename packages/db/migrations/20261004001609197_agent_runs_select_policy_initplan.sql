-- Migration: agent_runs_select_policy_initplan
--
-- Supabase performance advisor lint `auth_rls_initplan` (WARN, EXTERNAL) on
-- public.agent_runs (KRTX-1131): the RLS policy agent_runs_select_policy calls
-- auth.uid() bare, so Postgres re-evaluates it for every row. The advisor's own
-- remediation wraps each call as (select auth.uid()) — auth.uid() is STABLE, so
-- the scalar sub-select plans as an InitPlan evaluated once per statement. The
-- filtered rows are unchanged.
--
-- public.agent_runs is a pre-baseline legacy table (the retired backend's run
-- history, read over PostgREST only; the baseline never creates it), so the
-- guards below make this migration a no-op on fresh installs and CI databases.
--
-- The rewrite ALTERs the policy in place and re-stores THAT environment's own
-- predicate: it reads the stored qual from pg_policies and writes it back with
-- only the auth.uid() calls wrapped. It hardcodes no legacy column, so an
-- environment whose policy predates or postdates prod's keeps exactly its own
-- semantics — the first attempt hardcoded prod's policy text and halted every
-- dev deploy when bare `projects` resolved to kortix.projects (learning
-- 2026-10-03T151842Z). The skip guard is the advisor's own rule (lower(qual)
-- not like '%select auth.uid()%'), so a rerun no-ops exactly when the advisor
-- stops flagging. A qual with no bare auth.uid() call at all is left alone
-- as well: no predicate changes, no lock taken.
--
-- Every relation this file writes is schema-qualified. The stored qual itself
-- keeps bare table names, as every RLS policy does; Postgres re-resolves them
-- per querying role at planning, and this rewrite does not change that text
-- apart from the wraps. The ALTER's own parse runs with public first, the
-- resolution the legacy policy was created under — dev's migrate role resolves
-- bare names kortix-first, where kortix.projects has no is_public. If the
-- stored qual still fails to parse in some environment, or the migrate role
-- does not own the legacy table there, the subtransaction downgrades that to
-- a NOTICE and leaves the working policy untouched instead of halting the
-- deploy.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Catalog-only DDL: ALTER POLICY takes an ACCESS EXCLUSIVE lock on agent_runs,
-- held to commit; the table serves only legacy PostgREST reads.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $agent_runs_select_policy_initplan$
DECLARE
  stored_qual text;
  wrapped_qual text;
  previous_path text;
BEGIN
  IF to_regclass('public.agent_runs') IS NULL THEN
    RETURN;
  END IF;

  SELECT qual INTO stored_qual
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'agent_runs'
    AND policyname = 'agent_runs_select_policy';
  IF stored_qual IS NULL THEN
    RETURN;
  END IF;
  IF lower(stored_qual) LIKE '%select auth.uid()%' THEN
    RETURN;
  END IF;
  wrapped_qual := replace(stored_qual, 'auth.uid()', '(select auth.uid())');
  IF wrapped_qual = stored_qual THEN
    RETURN;  -- no bare auth.uid() call to wrap
  END IF;

  -- Parse the wrapped qual with the legacy resolution (public first), then
  -- restore the session path so nothing leaks into later migrations.
  previous_path := current_setting('search_path');
  PERFORM set_config('search_path', 'public, extensions', true);

  BEGIN
    EXECUTE format(
      'ALTER POLICY %I ON public.agent_runs USING (%s)',
      'agent_runs_select_policy', wrapped_qual
    );
  EXCEPTION WHEN undefined_column OR undefined_table OR undefined_object OR undefined_function
             OR insufficient_privilege THEN
    RAISE NOTICE 'agent_runs_select_policy left unchanged: % (%)', SQLERRM, SQLSTATE;
  END;

  PERFORM set_config('search_path', previous_path, true);
END
$agent_runs_select_policy_initplan$;
