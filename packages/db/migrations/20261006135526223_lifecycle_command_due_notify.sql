-- Migration: lifecycle_command_due_notify
--
-- A lifecycle command that becomes `queued`, or whose due time moves while it
-- is queued, notifies every API replica, so the drain wakes on the write
-- instead of polling every second (R9.2). One trigger covers every writer:
-- enqueue, each requeue, a hold release, a hand-back on shutdown. The payload
-- is the due time in epoch milliseconds; a replica schedules its drain for
-- that moment. A held inbox prompt is skipped: the claim never takes it until
-- an action lifts the hold, and that action is itself an UPDATE that notifies.
-- NOTIFY is delivered at commit, folds identical payloads within one
-- transaction, and costs nothing when no replica listens; the drain keeps a
-- slower poll as the fallback.
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE OR REPLACE FUNCTION kortix.session_lifecycle_command_due_notify()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = kortix, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'queued'
     AND OLD.available_at IS NOT DISTINCT FROM NEW.available_at
     AND COALESCE(OLD.result->>'held', '') IS NOT DISTINCT FROM COALESCE(NEW.result->>'held', '') THEN
    RETURN NULL;
  END IF;
  IF COALESCE(NEW.result->>'held', '') = 'true' AND NEW.payload->>'clientMessageId' IS NOT NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify(
    'kortix_lifecycle_command_due',
    floor(extract(epoch FROM NEW.available_at) * 1000)::bigint::text
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION kortix.session_lifecycle_command_due_notify() FROM PUBLIC;

CREATE OR REPLACE TRIGGER session_lifecycle_command_due_notify
  AFTER INSERT OR UPDATE OF status, available_at, result ON kortix.session_lifecycle_commands
  FOR EACH ROW
  WHEN (NEW.status = 'queued')
  EXECUTE FUNCTION kortix.session_lifecycle_command_due_notify();
