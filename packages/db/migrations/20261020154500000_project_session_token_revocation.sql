-- Migration: project_session_token_revocation
-- mixed-version-safe: old API replicas archive projects and mint tokens through these same tables.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Archive and revocation commit together. Operator PATs are not session credentials.
CREATE FUNCTION kortix.revoke_archived_project_session_tokens() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'archived' THEN
    UPDATE kortix.account_tokens
       SET status = 'revoked', revoked_at = coalesce(revoked_at, now())
     WHERE project_id = NEW.project_id AND account_id = NEW.account_id
       AND session_id IS NOT NULL AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revoke_archived_project_session_tokens
AFTER UPDATE OF status ON kortix.projects
FOR EACH ROW EXECUTE FUNCTION kortix.revoke_archived_project_session_tokens();

-- Serialize late mint/reactivation with archive on the project row. FOR SHARE
-- conflicts with UPDATE's NO KEY UPDATE lock; KEY SHARE would not.
CREATE FUNCTION kortix.guard_archived_project_session_token() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE project_status text;
BEGIN
  -- Ordinary usage/grant updates must not take a project lock after a token
  -- lock: archive takes those locks in the opposite order.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.session_id IS NOT DISTINCT FROM OLD.session_id
       AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
       AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id
       AND NEW.revoked_at IS NOT DISTINCT FROM OLD.revoked_at THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.session_id IS NOT NULL AND NEW.project_id IS NOT NULL AND NEW.status = 'active' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT status INTO project_status FROM kortix.projects
       WHERE project_id = NEW.project_id AND account_id = NEW.account_id FOR SHARE;
    ELSE
      -- A reactivation/rebind already holds the token lock. Fail closed on
      -- contention instead of waiting in the reverse lock order of archive.
      SELECT status INTO project_status FROM kortix.projects
       WHERE project_id = NEW.project_id AND account_id = NEW.account_id FOR SHARE NOWAIT;
    END IF;
    IF project_status = 'archived' THEN
      NEW.status := 'revoked';
      NEW.revoked_at := coalesce(NEW.revoked_at, now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_archived_project_session_token
BEFORE INSERT OR UPDATE ON kortix.account_tokens
FOR EACH ROW EXECUTE FUNCTION kortix.guard_archived_project_session_token();
