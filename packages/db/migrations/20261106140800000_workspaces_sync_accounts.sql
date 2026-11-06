-- Migration: workspaces_sync_accounts
--
-- Workspaces M5b (design: .agents/skills/learnings/work/workspaces/design.md §3.2 C1, §3.3).
-- AFTER INSERT OR UPDATE OR DELETE row trigger on kortix.accounts:
-- kortix.workspaces_reconcile_account(account_id). A new account gets its
-- project-less row (dormant); a settings or name change rewrites its live row;
-- a deleted account loses every row (tombstones included). An UPDATE that
-- changes no column returns at once.
--
-- Locks: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on kortix.accounts (writes
-- wait, reads do not) until this file commits. One hot table in this file.
-- 3s lock_timeout: on 55P03 the file rolls back: confirm no ledger row, find
-- the holder in pg_stat_activity, rerun the migrate job. Never raise the
-- timeout.
--
-- Mixed-version deploy: the trigger writes only kortix.workspaces, which the
-- old image never names.
--
-- ROLL BACK: no down migration (repo policy). A forward migration drops the
-- trigger: DROP TRIGGER IF EXISTS accounts_workspaces_sync ON kortix.accounts.
set lock_timeout = '3s';
set statement_timeout = '30s';

CREATE FUNCTION kortix.workspaces_sync_accounts() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM kortix.workspaces_reconcile_account(OLD.account_id);
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN
    RETURN NULL;
  END IF;
  PERFORM kortix.workspaces_reconcile_account(NEW.account_id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER accounts_workspaces_sync
  AFTER INSERT OR UPDATE OR DELETE ON kortix.accounts
  FOR EACH ROW
  EXECUTE FUNCTION kortix.workspaces_sync_accounts();
