-- Migration: repair_sandbox_deadline_guard
--
set lock_timeout = '2s';
set statement_timeout = '30s';

-- A previous merge renamed an already-applied migration after its trigger
-- function had changed. The ledger repair maps the applied name to the renamed
-- file. This roll-forward migration ensures every existing environment receives
-- the final trigger behavior. CREATE OR REPLACE keeps the existing trigger live.
CREATE OR REPLACE FUNCTION "kortix"."session_sandboxes_anchor_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  derived boolean := false;
  meta jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.active_since := now();
    IF NEW.deadline_at <= NEW.active_since THEN
      NEW.deadline_at := now() + interval '20 minutes';
    END IF;
    IF jsonb_typeof(NEW.metadata) = 'object' THEN
      NEW.metadata := NEW.metadata - 'stretchParkedAt';
    END IF;
    RETURN NEW;
  END IF;

  NEW.active_since := OLD.active_since;

  meta := CASE WHEN jsonb_typeof(NEW.metadata) = 'object' THEN NEW.metadata ELSE '{}'::jsonb END;
  IF jsonb_typeof(OLD.metadata) = 'object' AND OLD.metadata ? 'stretchParkedAt' THEN
    meta := meta || jsonb_build_object('stretchParkedAt', OLD.metadata -> 'stretchParkedAt');
  ELSE
    meta := meta - 'stretchParkedAt';
  END IF;
  NEW.metadata := meta;

  IF OLD.status = 'active'
     AND (NEW.status IN ('stopped', 'error', 'archived')
          OR (NEW.status = 'provisioning' AND NEW.external_id IS NULL)) THEN
    NEW.metadata := NEW.metadata || jsonb_build_object('stretchParkedAt', to_jsonb(now()));
  END IF;

  IF OLD.status <> 'active' AND NEW.status = 'active' THEN
    IF jsonb_typeof(OLD.metadata) = 'object' AND OLD.metadata ? 'stretchParkedAt' THEN
      NEW.active_since := now();
      NEW.metadata := NEW.metadata - 'stretchParkedAt';
    ELSIF NEW.active_since + interval '24 hours' < now() + interval '20 minutes' THEN
      NEW.active_since := now();
    END IF;
    IF NEW.deadline_at IS NOT DISTINCT FROM OLD.deadline_at THEN
      NEW.deadline_at := GREATEST(OLD.deadline_at, now() + interval '20 minutes');
      derived := true;
    ELSIF NEW.deadline_at <= now() THEN
      NEW.deadline_at := now() + interval '20 minutes';
      derived := true;
    END IF;
  END IF;

  IF derived THEN
    NEW.deadline_at := LEAST(NEW.deadline_at, NEW.active_since + interval '24 hours');
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN "kortix"."session_sandboxes"."active_since" IS
  'Start of this box''s current continuous running stretch. Anchor operand of the 24h cap. Assigned ONLY by kortix.session_sandboxes_anchor_guard(); never movable by application code in any state, and re-anchored only on resume of a park the trigger itself witnessed.';
