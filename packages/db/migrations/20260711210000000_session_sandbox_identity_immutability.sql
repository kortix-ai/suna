-- A materialized session sandbox may contain user-authored, uncommitted data.
-- Its provider identity is immutable for the lifetime of the session. Runtime
-- health checks may stop or flag it, but may never swap in an empty sandbox.

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

    IF NOT coalesce(session_deleted, false)
       AND coalesce(OLD.metadata->>'identityDeletionAuthorizedAt', '') = '' THEN
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

DROP TRIGGER IF EXISTS trg_session_sandbox_identity_immutable
  ON kortix.session_sandboxes;

CREATE TRIGGER trg_session_sandbox_identity_immutable
BEFORE UPDATE OF external_id, provider OR DELETE
ON kortix.session_sandboxes
FOR EACH ROW
EXECUTE FUNCTION kortix.guard_session_sandbox_identity();
