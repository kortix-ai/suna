-- Migration: workspaces_account_name_sync
--
-- Workspaces M1b (design: .agents/skills/learnings/work/workspaces/design.md §3.3).
-- The reverse half of the 1:1 name mirror of 20261106153010000_workspaces_expand.sql:
-- accounts.name -> projects.name of the account's ONLY active project. It lives
-- in its own file so the migration that locks kortix.projects never waits for
-- the lock of kortix.accounts as well (review finding 29: one hot table per
-- file).
--
-- Idempotent on a database that ran the first version of M1, which created
-- this function and trigger already: CREATE OR REPLACE for both (PG 14+).
--
-- Locks: CREATE (OR REPLACE) TRIGGER takes SHARE ROW EXCLUSIVE on
-- kortix.accounts (~49k rows on prod): writes to accounts wait, reads do not.
-- 3s lock_timeout. On 55P03 the file rolls back: confirm no ledger row, find
-- the holder in pg_stat_activity, rerun the migrate job. Never raise the
-- timeout.
--
-- Mixed-version deploy: old API images never name the function or trigger.
-- The trigger fires only on `UPDATE OF name` when the name changes, and writes
-- only the name (and updated_at) of the only active project of a 1:1 account.
-- pg_trigger_depth() >= 2 returns at once, so the mirror never ping-pongs with
-- projects_name_sync.
--
-- ROLL BACK: no down migration (repo policy). A forward migration drops the
-- trigger: DROP TRIGGER IF EXISTS accounts_name_sync ON kortix.accounts.
set lock_timeout = '3s';
set statement_timeout = '30s';

CREATE OR REPLACE FUNCTION kortix.workspace_account_name_sync() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF pg_trigger_depth() >= 2 THEN
    RETURN NULL;
  END IF;
  IF (SELECT count(*) FROM kortix.projects p
       WHERE p.account_id = NEW.account_id AND p.status = 'active') <> 1 THEN
    RETURN NULL;
  END IF;
  UPDATE kortix.projects p
     SET name = NEW.name, updated_at = now()
   WHERE p.account_id = NEW.account_id
     AND p.status = 'active'
     AND p.name IS DISTINCT FROM NEW.name;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER accounts_name_sync
  AFTER UPDATE OF name ON kortix.accounts
  FOR EACH ROW
  WHEN (NEW.name IS DISTINCT FROM OLD.name)
  EXECUTE FUNCTION kortix.workspace_account_name_sync();
