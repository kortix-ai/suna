-- Migration: workspaces_sync_projects
--
-- Workspaces M5a (design: .agents/skills/learnings/work/workspaces/design.md §3.2 C1, §3.3).
-- Two AFTER row triggers on kortix.projects:
--
--   projects_split_pending_sync  AFTER INSERT OR UPDATE OF status, account_id.
--     Keeps split_pending true exactly while the account holds 2+ active
--     project rows (review finding 27): archiving one project of a legacy
--     2-project account clears the flag on the survivor, so the account comes
--     back under uq_projects_workspace_account. It replaced the app-level
--     recomputeSplitPending of the transfer engine (removed on this branch),
--     for NEW.account_id and, when it changed, OLD.account_id. Depth-guarded
--     (pg_trigger_depth() > 1 returns): its own UPDATE never re-enters it.
--   projects_workspaces_sync  AFTER INSERT OR UPDATE OR DELETE.
--     Calls kortix.workspaces_reconcile_account for the row's account (both
--     accounts, lower id first, when account_id changed). An UPDATE that
--     changes no column returns at once.
-- Trigger names order the two: AFTER row triggers of one event fire in name
-- order, so the flag is right before the reconcile reads it.
--
-- Locks: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on kortix.projects (writes
-- wait, reads do not) until this file commits. 3s lock_timeout: on 55P03 the
-- file rolls back: confirm no ledger row, find the holder in pg_stat_activity,
-- rerun the migrate job. Never raise the timeout.
--
-- Cost: every write of a project row now reconciles its account (one account
-- row lock, one read of the account's few project rows, at most a few writes
-- to kortix.workspaces).
--
-- Mixed-version deploy: the old image writes projects the same way; the
-- triggers only write kortix.workspaces (unknown to it) and split_pending
-- (which it never reads).
--
-- ROLL BACK: no down migration (repo policy). A forward migration drops the
-- two triggers. The app no longer recomputes split_pending itself, so a
-- rollback that drops projects_split_pending_sync must ship with a release
-- that restores that recompute, or split_pending stops following the account
-- shape.
set lock_timeout = '3s';
set statement_timeout = '30s';

CREATE FUNCTION kortix.workspace_split_pending_sync() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  FOR v_account IN
    SELECT DISTINCT x
      FROM (VALUES (NEW.account_id),
                   (CASE WHEN TG_OP = 'UPDATE' THEN OLD.account_id END)) AS v(x)
     WHERE x IS NOT NULL
  LOOP
    UPDATE kortix.projects p SET split_pending = sub.multi
      FROM (SELECT count(*) > 1 AS multi FROM kortix.projects
             WHERE account_id = v_account AND status = 'active') sub
     WHERE p.account_id = v_account AND p.status = 'active'
       AND p.split_pending IS DISTINCT FROM sub.multi;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE FUNCTION kortix.workspaces_sync_projects() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM kortix.workspaces_reconcile_account(OLD.account_id);
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD IS NOT DISTINCT FROM NEW THEN
      RETURN NULL;
    END IF;
    IF OLD.account_id IS DISTINCT FROM NEW.account_id THEN
      -- One lock order for two accounts: the lower id first.
      PERFORM kortix.workspaces_reconcile_account(least(OLD.account_id, NEW.account_id));
      PERFORM kortix.workspaces_reconcile_account(greatest(OLD.account_id, NEW.account_id));
      RETURN NULL;
    END IF;
  END IF;
  PERFORM kortix.workspaces_reconcile_account(NEW.account_id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER projects_split_pending_sync
  AFTER INSERT OR UPDATE OF status, account_id ON kortix.projects
  FOR EACH ROW
  EXECUTE FUNCTION kortix.workspace_split_pending_sync();

CREATE TRIGGER projects_workspaces_sync
  AFTER INSERT OR UPDATE OR DELETE ON kortix.projects
  FOR EACH ROW
  EXECUTE FUNCTION kortix.workspaces_sync_projects();
