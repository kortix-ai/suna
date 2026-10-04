-- Migration: agent_runs_rls_auth_initplan
--
-- KRTX-1131. The Supabase performance advisor (lint `auth_rls_initplan`, WARN,
-- EXTERNAL) flags the RLS policy `agent_runs_select_policy` on the legacy table
-- `public.agent_runs`: its expressions call `auth.uid()` bare, so Postgres
-- re-evaluates the call for every scanned row instead of planning it once per
-- statement. The fix is the advisor's own remediation: wrap each bare
-- `auth.<function>()` in a scalar sub-select, `(select auth.<function>())`.
-- `auth.uid()` is STABLE, the wrapped call becomes an InitPlan, and the rows
-- the policy returns are unchanged.
--
-- Every policy on the table is rewritten IN PLACE from its own stored
-- expression. ALTER POLICY keeps name, roles, command and permissiveness, and
-- the new expression is the stored qual with only the bare auth calls wrapped.
-- This is what the earlier DROP+CREATE rewrite of this policy got wrong
-- (removed again in #8852): it transcribed prod's policy text — including
-- `projects.is_public` / `threads.is_public`, columns that exist only in prod —
-- and halted every dev deploy at the apply. Altering each environment's own
-- expression needs no column name at all: prod keeps its is_public predicates,
-- dev keeps whatever its legacy policy references, and a clause with no bare
-- auth call is left untouched.
--
-- public.agent_runs is a pre-baseline legacy table: the managed surface is the
-- kortix schema, fresh databases (local, CI, self-host) never create it, and
-- no migration in this repo does either. The to_regclass guard makes this
-- migration a no-op there, and it never creates a policy that was not already
-- present.
--
-- mixed-version-safe: catalog-only rewrite with identical access semantics in
-- every environment; no data changes, and app code never references RLS
-- policies by name.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE OR REPLACE FUNCTION pg_temp.wrap_auth_initplan(expr text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  -- Wrap each zero-argument auth.*() call in a scalar sub-select — the
  -- advisor's own remediation — then collapse a call that was already wrapped
  -- (a database this migration fixed on a previous apply) so re-applying is a
  -- no-op instead of nesting one more sub-select each run. The stored form
  -- deparses with a target alias (`( SELECT auth.uid() AS uid)`), so the
  -- collapse tolerates it. current_setting() takes arguments and is not
  -- rewritten here; no policy on this table calls it.
  SELECT regexp_replace(
    regexp_replace(expr,
      '\mauth\.(uid|role|jwt|email)\(\)', '(select auth.\1())', 'g'),
    '\(\s*select\s+\(select auth\.(uid|role|jwt|email)\(\)\)(\s+as\s+\w+)?\)',
    '(select auth.\1())', 'gi')
$fn$;

DO $agent_runs_rls_auth_initplan$
DECLARE
  pol_name text;
  pol record;
  new_qual text;
  new_check text;
  clauses text;
BEGIN
  IF to_regclass('public.agent_runs') IS NULL THEN
    RETURN;
  END IF;

  -- pg_policies renders each stored expression relative to the session
  -- search_path (with auth on the path it even prints `auth.uid()` as bare
  -- `uid()`), and the ALTER below re-parses that text in this same session.
  -- Pin one path for both sides: the wrap always sees the qualified
  -- `auth.<fn>()` form the advisor lints, bare legacy table names bind to
  -- public.*, and deparse and parse agree on every environment whatever
  -- search_path the migrate role carries (dev's resolves bare names against
  -- kortix.* first — learnings 2026-10-03). Transaction-local; because the
  -- runner applies the whole pending batch in one transaction, later
  -- migrations in the same batch inherit this path — safe while every
  -- migration schema-qualifies its relations (the house rule).
  PERFORM set_config('search_path', 'public', true);

  FOR pol_name IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_runs'
    ORDER BY policyname
  LOOP
    SELECT qual, with_check INTO pol FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_runs'
      AND policyname = pol_name;
    clauses := '';
    new_qual := pg_temp.wrap_auth_initplan(pol.qual);
    IF new_qual IS DISTINCT FROM pol.qual THEN
      clauses := format(' USING (%s)', new_qual);
    END IF;
    new_check := pg_temp.wrap_auth_initplan(pol.with_check);
    IF new_check IS DISTINCT FROM pol.with_check THEN
      clauses := clauses || format(' WITH CHECK (%s)', new_check);
    END IF;
    IF clauses <> '' THEN
      EXECUTE format('ALTER POLICY %I ON public.agent_runs%s', pol_name, clauses);
    END IF;
  END LOOP;
END
$agent_runs_rls_auth_initplan$;
