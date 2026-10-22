-- Migration: ephemeral_sessions
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Ephemeral sandboxes (project flag `ephemeral_sandboxes`): a stop DELETES the
-- provider box and keeps the session's state on a volume. The row then gives up
-- its external id, which the identity guard otherwise forbids.
--
-- One narrow admission, all of it checked here rather than trusted to the
-- caller: the row moves to `stopped` in the same write, the provider does not
-- change, and the new metadata names the exact external id it retires under
-- `ephemeralRetiredExternalId`. Every other change of an established identity
-- still raises. The wake deletes the retired row (its external id is NULL, so
-- the DELETE branch already allows it) and the normal allocation inserts anew.

CREATE OR REPLACE FUNCTION kortix.guard_session_sandbox_identity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  session_deleted boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.external_id IS NOT NULL THEN
    IF NEW.external_id IS NULL
       AND NEW.provider IS NOT DISTINCT FROM OLD.provider
       AND NEW.status = 'stopped'
       AND jsonb_typeof(NEW.metadata) = 'object'
       AND NEW.metadata->>'ephemeralRetiredExternalId' = OLD.external_id THEN
      RETURN NEW;
    END IF;
    IF NEW.external_id IS DISTINCT FROM OLD.external_id
       OR NEW.provider IS DISTINCT FROM OLD.provider THEN
      RAISE EXCEPTION
        'established session sandbox identity is immutable (session %, provider %, external_id %)',
        OLD.session_id, OLD.provider, OLD.external_id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' AND OLD.external_id IS NOT NULL THEN
    SELECT coalesce((metadata->>'deletedAt') IS NOT NULL, false)
      INTO session_deleted
      FROM kortix.project_sessions
     WHERE session_id = OLD.session_id;

    IF NOT coalesce(session_deleted, false) THEN
      RAISE EXCEPTION
        'refusing to delete established session sandbox identity (session %, provider %, external_id %)',
        OLD.session_id, OLD.provider, OLD.external_id
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
-- An ephemeral session's state volume, when its session row goes (a project
-- or account cascade; the session delete route queues it itself). The volume
-- is named from the session id, `kss-<session id>`: the trigger derives that
-- name and queues it only when the session recorded exactly that volume, so
-- a value written into session metadata by anything else can never nominate
-- another volume for deletion.
CREATE OR REPLACE FUNCTION kortix.queue_session_state_volume_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  own_volume text := 'kss-' || OLD.session_id::text;
BEGIN
  IF OLD.metadata ->> 'ephemeral_state_volume' = own_volume THEN
    INSERT INTO kortix.platinum_volume_deletions (volume_name, reason)
    VALUES (own_volume, 'session_deleted')
    ON CONFLICT (volume_name) DO NOTHING;
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_sessions_queue_state_volume_deletion ON kortix.project_sessions;
--> statement-breakpoint
CREATE TRIGGER project_sessions_queue_state_volume_deletion
AFTER DELETE ON kortix.project_sessions
FOR EACH ROW EXECUTE FUNCTION kortix.queue_session_state_volume_deletion();
