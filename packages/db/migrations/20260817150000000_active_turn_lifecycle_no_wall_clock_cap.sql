-- Active OpenCode turns must renew through provider-native lifecycle timers for
-- as long as the control plane continues to observe the exact turn in flight.
-- The former 24-hour deadline CHECK stopped a verified active turn at a fixed
-- wall-clock boundary. Idle sandboxes remain bounded by deadline_at and the
-- reaper; active turn records cannot renew without fresh OpenCode evidence.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- mixed-version-safe: old API versions clamp every deadline to the former 24-hour cap; removing the CHECK accepts those unchanged writes and rollback remains safe.
ALTER TABLE "kortix"."session_sandboxes"
  DROP CONSTRAINT IF EXISTS "session_sandboxes_deadline_within_cap";

CREATE OR REPLACE FUNCTION "kortix"."session_sandboxes_anchor_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  derived boolean := false;
  meta jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.active_since := now();
    IF NEW.deadline_at <= NEW.active_since THEN
      NEW.deadline_at := now() + interval '15 minutes';
    END IF;
    IF jsonb_typeof(NEW.metadata) = 'object' THEN
      NEW.metadata := NEW.metadata - 'stretchParkedAt';
    END IF;
    RETURN NEW;
  END IF;

  -- active_since remains the immutable start of the current provider run. It
  -- is observability data, not a lifecycle ceiling.
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
    END IF;
    IF NEW.deadline_at IS NOT DISTINCT FROM OLD.deadline_at THEN
      NEW.deadline_at := GREATEST(OLD.deadline_at, now() + interval '15 minutes');
      derived := true;
    ELSIF NEW.deadline_at <= now() THEN
      NEW.deadline_at := now() + interval '15 minutes';
      derived := true;
    END IF;
  END IF;

  IF derived THEN
    NEW.metadata := NEW.metadata || jsonb_build_object('deadlineGrant', 'boot_floor');
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN "kortix"."session_sandboxes"."active_since" IS
  'Start of the current provider run. Assigned only by kortix.session_sandboxes_anchor_guard(); immutable during a run and re-anchored after a witnessed park.';
COMMENT ON COLUMN "kortix"."session_sandboxes"."deadline_at" IS
  'When the reaper may stop this box. Active turns renew it only after fresh control-plane observation of the exact OpenCode turn.';
