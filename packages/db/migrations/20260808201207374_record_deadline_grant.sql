-- Migration: record_deadline_grant
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHY THIS EXISTS
--
-- A parked sandbox records WHY it stopped (metadata.stopReason), but every
-- deadline park collapses to one value: `deadline_expired`. The reason is that
-- the writers move `deadline_at` without ever recording WHICH grant moved it,
-- so by the time the reaper stops a box, a 15-minute idle tail is byte-identical
-- to the 20-minute floor a box receives when it is resumed. Nothing at the stop
-- site can tell them apart, and guessing there would produce confidently-wrong
-- attribution rather than a coarse-but-honest one.
--
-- That gap hides a real user-visible failure: a user reopens a parked session,
-- reads for twenty minutes without sending a prompt, and the box dies AGAIN
-- under the bare resume floor. Reading a transcript earns no observation, so the
-- floor is the box's entire life. Today that stop is indistinguishable from an
-- ordinary idle park, which means the population cannot be measured and a fix
-- for it cannot be shown to have worked.
--
-- This records the grant at the moment it is applied. The TRIGGER owns the
-- resume floor -- application code cannot see it, which is exactly why a
-- TypeScript-only solution would miss the one case that matters -- so the stamp
-- has to live here. The application writers stamp their own grants (turn start,
-- LLM activity, preview use, idle grace) from sandbox-deadline.ts.
--
-- Behaviour change: none. This adds a metadata key and alters no control flow,
-- no timing, and no value of deadline_at or active_since. `deadline_at` remains
-- the single stop authority.
--
-- No mixed-version annotation: this neither drops, renames, nor retypes
-- anything. Old application code ignores unknown metadata keys, and the column
-- is already a free-form jsonb bag.

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
    -- `derived` is true in exactly the two branches above, and those are the
    -- ONLY places the resume floor is applied: the caller did not supply a
    -- deadline, or supplied one already in the past. So this flag is a precise
    -- answer to "did the box get nothing but the floor?", which is the question
    -- the reopen-then-read failure needs answered.
    --
    -- Deliberately NOT stamped on INSERT: a fresh provision also receives a
    -- 20-minute floor, but it is a different population from a resumed session
    -- a human is sitting in front of, and merging the two would defeat the
    -- measurement this key exists to enable.
    --
    -- Any later application write that moves `deadline_at` overwrites this key
    -- with its own grant, so the value always describes the deadline currently
    -- in force rather than a historical one.
    NEW.metadata := NEW.metadata || jsonb_build_object('deadlineGrant', 'boot_floor');
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN "kortix"."session_sandboxes"."deadline_at" IS
  'When the reaper may stop this box. THE single stop authority for a running box. Pushed out only by a control-plane-observed event and pulled in only by a sandbox-reported terminal turn end, both bounded by active_since + 24h. metadata.deadlineGrant names which grant set the value currently in force; ''boot_floor'' means the box received nothing but the resume floor.';
