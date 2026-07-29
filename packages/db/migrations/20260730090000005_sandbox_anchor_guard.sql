-- Migration: sandbox_anchor_guard
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- BOUNDED SANDBOX LIFETIME, step 6/7 -- THE MOST LOAD-BEARING OBJECT IN THE
-- DESIGN. This is what turns "every caller must remember to anchor" into "the
-- database does it".
--
-- It enforces two invariants that no amount of application discipline can:
--
--   I1  active_since is IMMUTABLE while status = 'active'. No caller, present
--       or future, can slide the cap's operand forward while the box runs. The
--       CHECK added in step 4 constrains a difference; without this it would be
--       defeated by anything that re-anchors -- and the platform already has
--       such a path: passive port-8000 traffic can auto-resume a stopped box,
--       and the resume path DELETES the idle-quiesce markers as its first act.
--
--   I4  Every non-active -> active transition is ANCHORED. Anchoring is a
--       property of the TRANSITION, not of the writer, so a path that flips a
--       row to active without touching the deadline (the proxy heal in
--       sandbox-proxy/backend.ts, an in-place restart, in-place runtime
--       recovery) cannot produce an unanchored active row -- and, just as
--       important, cannot inherit a stale, already-expired deadline that would
--       have the box re-killed on the very next sweep.
--
-- DELIBERATELY NO SILENT CLAMP of deadline_at to the cap. Clamping here would
-- make the step-4 CHECK unreachable and hide the exact class of future bug the
-- CHECK exists to surface. Loud over silent.
--
-- DELIBERATELY NO FLAP COOLDOWN. An earlier revision refused a fresh anchor
-- unless the box had been parked for N minutes, to defeat a stop->resume duty
-- cycle. Rejected: it produces a hard 23514 on the user-visible "click Start"
-- path whenever the carried-forward anchor is already older than 24h, and it is
-- unnecessary once the CAUSE of the flap is removed -- the auto-resume gate in
-- sandbox-proxy/routes/preview.ts now requires observed turn intent, so
-- sustaining a flap requires a real prompt per grant, which is a working box.
-- Monitor M4 (run-window churn) is the backstop if that reasoning is wrong.
CREATE OR REPLACE FUNCTION "kortix"."session_sandboxes_anchor_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'active' THEN
      NEW.active_since := now();
    END IF;
    -- THE BOOT FLOOR, for every insert regardless of status. A row is normally
    -- born `provisioning` and flipped to `active` once the provider returns, so
    -- a floor applied only to `active` inserts would leave every in-flight
    -- provision carrying the column default -- i.e. a deadline equal to its own
    -- creation instant, expired from birth, and a kill candidate before the VM
    -- has finished booting.
    --
    -- `<= active_since` rather than `IS NULL` is what makes this robust: the
    -- column is NOT NULL with a default, so "the writer said nothing" is never
    -- observable as NULL. No legitimate writer ever states a deadline at or
    -- before the anchor, so that comparison is an exact test for "no meaningful
    -- deadline was supplied", and it additionally repairs a stale value rather
    -- than trusting it. 20 minutes is BOOT_GRACE_MS in
    -- apps/api/src/projects/lifetime/constants.ts, which must exceed the
    -- runtime-readiness wait (READY_DEADLINE_MS, 5 min) plus two maintenance
    -- ticks -- otherwise a cold-boot trigger session is killed by the same
    -- clock that is waiting for it to become usable.
    IF NEW.deadline_at <= NEW.active_since THEN
      NEW.deadline_at := now() + interval '20 minutes';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'active' THEN
    -- I1. Silently carried forward rather than raised: an UPDATE that happens
    -- to re-send the row's columns (a whole-object write from an ORM) is not a
    -- bug and must not 500 a hot path. What matters is that the value cannot
    -- MOVE, and here it cannot.
    NEW.active_since := OLD.active_since;

  ELSIF OLD.status <> 'active' AND NEW.status = 'active' THEN
    -- I4. A real new running stretch begins.
    NEW.active_since := now();
    -- Supply the floor in the two cases where the row would otherwise start its
    -- new stretch already dead:
    --   (a) the writer did not state a deadline at all -- the proxy heal,
    --       restart-in-place and in-place-recovery paths all flip status
    --       without touching this column, and would inherit the deadline the
    --       box carried when it was parked;
    --   (b) the writer did state one, but it is already in the past.
    -- Either way the box would be re-killed on the very next sweep, which
    -- presents to a user as "Start does nothing".
    -- IS NOT DISTINCT FROM (not `=`) so a NULL-to-NULL comparison counts as
    -- "unchanged" rather than evaluating to NULL and falling through.
    IF NEW.deadline_at IS NOT DISTINCT FROM OLD.deadline_at OR NEW.deadline_at <= now() THEN
      NEW.deadline_at := now() + interval '20 minutes';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_session_sandboxes_anchor_guard" ON "kortix"."session_sandboxes";

CREATE TRIGGER "trg_session_sandboxes_anchor_guard"
BEFORE INSERT OR UPDATE ON "kortix"."session_sandboxes"
FOR EACH ROW EXECUTE FUNCTION "kortix"."session_sandboxes_anchor_guard"();
