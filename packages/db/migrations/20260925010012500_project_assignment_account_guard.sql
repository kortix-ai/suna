-- Migration: project_assignment_account_guard
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- 1. A project-scoped role assignment belongs to the project's own account.
--
-- `role_assignments.scope_id` references `projects.project_id`, but nothing
-- tied the row's `account_id` to that project's account. The API now refuses
-- such a write (`assertProjectInAccount` in apps/api/src/iam/assignments.ts),
-- and the engine's project readers filter by the project's account. This
-- trigger is the same rule at the storage layer, for every writer: the API,
-- the legacy mirror triggers, and support scripts.
--
-- A trigger rather than a composite FK: the FK would need a new unique index
-- on projects(project_id, account_id) and a validation pass over existing rows.
-- The trigger checks new writes only; existing rows are already ignored by the
-- account-filtered readers.
-- mixed-version-safe: only rejects project-scoped rows whose account differs from the project's account; no API version writes such a row on purpose

CREATE OR REPLACE FUNCTION kortix.role_assignments_project_account_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = kortix, pg_temp
AS $$
BEGIN
  IF NEW.scope_type = 'project' AND NEW.scope_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM kortix.projects
    WHERE project_id = NEW.scope_id AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'project % does not belong to account %', NEW.scope_id, NEW.account_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION kortix.role_assignments_project_account_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS role_assignments_project_account_guard ON kortix.role_assignments;
CREATE TRIGGER role_assignments_project_account_guard
  BEFORE INSERT OR UPDATE OF account_id, scope_type, scope_id ON kortix.role_assignments
  FOR EACH ROW EXECUTE FUNCTION kortix.role_assignments_project_account_guard();

-- 2. Drop the legacy "internal users" read policies.
--
-- Hosted environments still carry a policy named "Give read only access to
-- internal users" on the legacy `public.messages`, `public.projects` and
-- `public.threads` tables. It grants read access from a JWT email suffix, and a
-- JWT email is not proof of domain ownership. No code reads these tables
-- through PostgREST. The baseline never created the policy, so every statement
-- is guarded.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['messages', 'projects', 'threads'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Give read only access to internal users', t);
    END IF;
  END LOOP;
END
$$;
