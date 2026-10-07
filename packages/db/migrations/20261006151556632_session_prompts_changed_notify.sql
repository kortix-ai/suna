-- Migration: session_prompts_changed_notify
--
-- A `continue_session` row (one prompt of a session's inbox) that is written,
-- moved, or deleted notifies every API replica with its session id (R10.2).
-- Each replica re-reads that session's queue now if a client watches it, so
-- the `kortix.control.queue` frame follows the write instead of the 5 s
-- reconcile cadence, whichever replica served the write. One trigger covers
-- every writer. An UPDATE that changes no field a client reads (a lease
-- renewal, `updated_at` alone) does not notify. NOTIFY is delivered at commit,
-- folds identical payloads within one transaction, and costs nothing when no
-- replica listens; the reconcile cadence stays as the fallback.
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE OR REPLACE FUNCTION kortix.session_prompts_changed_notify()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = kortix, pg_temp
AS $$
DECLARE
  changed kortix.session_lifecycle_commands%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed := OLD;
  ELSE
    changed := NEW;
  END IF;
  IF changed.command_type <> 'continue_session' OR changed.session_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status IS NOT DISTINCT FROM NEW.status
     AND OLD.result IS NOT DISTINCT FROM NEW.result
     AND OLD.payload IS NOT DISTINCT FROM NEW.payload
     AND OLD.available_at IS NOT DISTINCT FROM NEW.available_at
     AND OLD.attempts IS NOT DISTINCT FROM NEW.attempts
     AND OLD.last_error IS NOT DISTINCT FROM NEW.last_error THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify('kortix_session_prompts_changed', changed.session_id);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION kortix.session_prompts_changed_notify() FROM PUBLIC;

CREATE OR REPLACE TRIGGER session_prompts_changed_notify
  AFTER INSERT OR UPDATE OR DELETE ON kortix.session_lifecycle_commands
  FOR EACH ROW
  EXECUTE FUNCTION kortix.session_prompts_changed_notify();
