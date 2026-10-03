-- Migration: lifecycle_command_settled_notify
--
-- A lifecycle command leaving `running` notifies every API replica, so a caller
-- waiting on that settle (cancel of a prompt the drain is forwarding) wakes on
-- the change instead of polling. One trigger covers every writer: there are
-- about ten code paths that move a command out of `running`. The payload is
-- the command id only. NOTIFY is delivered at commit and costs nothing when no
-- replica listens; a listener that misses one falls back to its timeout.
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE OR REPLACE FUNCTION kortix.session_lifecycle_command_settled_notify()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = kortix, pg_temp
AS $$
BEGIN
  PERFORM pg_notify('kortix_lifecycle_command_settled', NEW.command_id::text);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION kortix.session_lifecycle_command_settled_notify() FROM PUBLIC;

CREATE OR REPLACE TRIGGER session_lifecycle_command_settled_notify
  AFTER UPDATE OF status ON kortix.session_lifecycle_commands
  FOR EACH ROW
  WHEN (OLD.status = 'running' AND NEW.status IS DISTINCT FROM 'running')
  EXECUTE FUNCTION kortix.session_lifecycle_command_settled_notify();
