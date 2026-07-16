-- An established sandbox identity is never automatically detachable.
--
-- The previous provider-loss recovery exception trusted an application-written
-- metadata marker and allowed external_id to be reset to NULL. A provider 404
-- or terminal-looking state is not proof that the user's disk is irrecoverable:
-- Platinum can retain a complete backup even when a VM reports failed-start.
-- Recovery must therefore revive the same external_id or fail closed.

CREATE OR REPLACE FUNCTION kortix.guard_session_sandbox_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_deleted boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.external_id IS NOT NULL THEN
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
$$;
