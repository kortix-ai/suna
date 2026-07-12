-- Provider-confirmed loss is the one safe exception to immutable runtime
-- identity: the original object no longer exists, so keep the logical sandbox
-- row and reset only its provider attachment for replacement provisioning.
CREATE OR REPLACE FUNCTION kortix.guard_session_sandbox_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_deleted boolean;
  recovery_authorized boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.external_id IS NOT NULL THEN
    recovery_authorized :=
      coalesce(NEW.metadata->>'identityRecoveryAuthorizedAt', '') <> ''
      AND NEW.external_id IS NULL
      AND NEW.provider = OLD.provider
      AND NEW.status = 'provisioning';

    IF (NEW.external_id IS DISTINCT FROM OLD.external_id
        OR NEW.provider IS DISTINCT FROM OLD.provider)
       AND NOT recovery_authorized THEN
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
