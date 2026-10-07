-- Migration: session_changed_notify
--
-- R5.1/R5.2: a change to a session's box or title notifies every API replica
-- with the session id on `kortix_session_changed`. Each replica then:
--   * wakes the `/events` streams of that session that wait for a box
--     (before: 1 SELECT every 5 s per open stream on a stopped box), and
--   * re-reads the session's control plane now, so `kortix.control.turn`,
--     `.runtime` and `.session` frames follow the write on every replica
--     instead of the 5 s reconcile cadence.
-- Only fields a client reads notify: sandbox status, external id, the live
-- turns, the wake fields and the stop reason; the session title. A deadline
-- renewal or `updated_at` alone does not. NOTIFY is delivered at commit, folds
-- identical payloads in one transaction, and costs nothing with no listener.
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE OR REPLACE FUNCTION kortix.session_sandbox_changed_notify()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = kortix, pg_temp
AS $$
DECLARE
  changed kortix.session_sandboxes%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed := OLD;
  ELSE
    changed := NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status IS NOT DISTINCT FROM NEW.status
     AND OLD.external_id IS NOT DISTINCT FROM NEW.external_id
     AND OLD.metadata->'activeTurns' IS NOT DISTINCT FROM NEW.metadata->'activeTurns'
     AND OLD.metadata->'activeTurn' IS NOT DISTINCT FROM NEW.metadata->'activeTurn'
     AND OLD.metadata->'stopReason' IS NOT DISTINCT FROM NEW.metadata->'stopReason'
     AND OLD.metadata->'runtimeWakeId' IS NOT DISTINCT FROM NEW.metadata->'runtimeWakeId'
     AND OLD.metadata->'runtimeWakeStartedAt' IS NOT DISTINCT FROM NEW.metadata->'runtimeWakeStartedAt'
     AND OLD.metadata->'runtimeWakeProviderStatus' IS NOT DISTINCT FROM NEW.metadata->'runtimeWakeProviderStatus'
     AND OLD.metadata->'wakeLadder' IS NOT DISTINCT FROM NEW.metadata->'wakeLadder' THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify('kortix_session_changed', changed.session_id);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION kortix.session_sandbox_changed_notify() FROM PUBLIC;

CREATE OR REPLACE TRIGGER session_sandbox_changed_notify
  AFTER INSERT OR UPDATE OR DELETE ON kortix.session_sandboxes
  FOR EACH ROW
  EXECUTE FUNCTION kortix.session_sandbox_changed_notify();

CREATE OR REPLACE FUNCTION kortix.project_session_title_changed_notify()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = kortix, pg_temp
AS $$
BEGIN
  IF OLD.metadata->'name' IS NOT DISTINCT FROM NEW.metadata->'name'
     AND OLD.metadata->'custom_name' IS NOT DISTINCT FROM NEW.metadata->'custom_name' THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify('kortix_session_changed', NEW.session_id::text);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION kortix.project_session_title_changed_notify() FROM PUBLIC;

CREATE OR REPLACE TRIGGER project_session_title_changed_notify
  AFTER UPDATE ON kortix.project_sessions
  FOR EACH ROW
  EXECUTE FUNCTION kortix.project_session_title_changed_notify();
