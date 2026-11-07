-- Migration: workspaces_sync_deletion_requests
--
-- Workspaces M5c (design: .agents/skills/learnings/work/workspaces/design.md §3.2 C1, §3.3).
-- AFTER INSERT OR UPDATE OR DELETE row trigger on
-- kortix.account_deletion_requests: kortix.workspaces_reconcile_account for
-- the request's account (and the old account, when an update moved it). An
-- open request (pending or processing) turns the account's live row to
-- 'closing' and sets deletion_scheduled_for; a cancel or completion turns it
-- back.
--
-- Locks: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on
-- kortix.account_deletion_requests (small, cold) until this file commits. 3s
-- lock_timeout: on 55P03 the file rolls back: confirm no ledger row, find the
-- holder in pg_stat_activity, rerun the migrate job. Never raise the timeout.
--
-- Mixed-version deploy: the trigger writes only kortix.workspaces, which the
-- old image never names.
--
-- ROLL BACK: no down migration (repo policy). A forward migration drops the
-- trigger: DROP TRIGGER IF EXISTS account_deletion_requests_workspaces_sync
-- ON kortix.account_deletion_requests.
set lock_timeout = '3s';
set statement_timeout = '30s';

CREATE FUNCTION kortix.workspaces_sync_deletion_requests() RETURNS trigger
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
      PERFORM kortix.workspaces_reconcile_account(least(OLD.account_id, NEW.account_id));
      PERFORM kortix.workspaces_reconcile_account(greatest(OLD.account_id, NEW.account_id));
      RETURN NULL;
    END IF;
  END IF;
  PERFORM kortix.workspaces_reconcile_account(NEW.account_id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER account_deletion_requests_workspaces_sync
  AFTER INSERT OR UPDATE OR DELETE ON kortix.account_deletion_requests
  FOR EACH ROW
  EXECUTE FUNCTION kortix.workspaces_sync_deletion_requests();
