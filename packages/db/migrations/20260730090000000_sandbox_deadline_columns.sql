-- Migration: sandbox_deadline_columns
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- BOUNDED SANDBOX LIFETIME, step 1/7 -- the two columns the whole model rests on.
--
-- Today a sandbox's maximum wall-clock life is CONTINGENT: it depends on a
-- sweep running, on a provider answering, and -- fatally -- on a signal the
-- sandbox itself authors. The in-box lease reporter renews every ~60s while
-- opencode believes any session is busy OR retrying, and the same write stamps
-- the fallback activity clock, so a wedged box grants itself immortality and
-- erases the evidence that would override it. Measured live: 187 running boxes,
-- 156 of which had never emitted a single LLM usage event, oldest 264 hours.
--
-- These two columns replace that with ARITHMETIC:
--
--   active_since   the start of this box's current CONTINUOUS RUNNING STRETCH.
--                  The anchor operand of the absolute cap. Assigned ONLY by the
--                  anchor-guard trigger (step 6) and IMMUTABLE while the row is
--                  active -- application code never assigns it. A CHECK on a
--                  difference whose operand any caller can slide forward is not
--                  a ceiling, which is precisely why this is a trigger and not
--                  a convention.
--
--   deadline_at    the instant the control plane stops this box unless
--                  something OBSERVED (and not sandbox-authored) moves it.
--                  Written only by apps/api/src/projects/lifetime/deadline.ts
--                  and by the two triggers, always as a single monotone
--                  GREATEST/LEAST statement -- which also removes the
--                  read-modify-write lost-update race class outright.
--
-- Both NOT NULL WITH DEFAULTS, deliberately: this migration runs while the OLD
-- API is still inserting session_sandboxes rows that know nothing about either
-- column. A NOT NULL column with no default would 500 every in-flight
-- provision for the length of the rollout.
--
-- Both defaults are a bare `now()` -- STABLE, not volatile -- so PG11+ stores
-- them as a missing value in the catalog: metadata-only, no table rewrite, no
-- long ACCESS EXCLUSIVE hold. Pre-existing rows therefore all land on one
-- shared constant; step 3 backfills the ones that matter (active/provisioning)
-- from evidence. Rows already stopped/archived keep the default and are never
-- kill candidates, so their value is inert.
--
-- WHY `deadline_at DEFAULT now()` AND NOT `now() + interval '20 minutes'`.
-- The interval form is the one you would write first, and it is what an earlier
-- revision had. squawk rejects it (adding-field-with-default) because it cannot
-- prove the composite expression is non-volatile, and rather than weaken a
-- zero-downtime linter to accommodate a default, the 20-minute floor moved to
-- where it belongs: the anchor-guard trigger in step 6, which floors any row
-- whose deadline is not meaningfully ahead of its anchor. That is strictly
-- better than a column default -- a default only fires when the column is
-- OMITTED, whereas the trigger also catches a writer that supplies a stale or
-- nonsensical value, and it covers the provisioning -> active transition, which
-- no column default can see.
--
-- Between this migration and step 6 the two are equal for a fresh insert, which
-- reads as "already expired". That window is closed inside the same migration
-- batch (node-pg-migrate wraps the run in one transaction), so no live row is
-- ever observable in that state.
--
-- NEVER ROLL THIS BACK. The columns are additive and inert with the code rolled
-- back to a version that ignores them. Dropping a NOT NULL column while any
-- instance still writes it converts a bad deploy into an outage.
ALTER TABLE "kortix"."session_sandboxes"
  ADD COLUMN "active_since" timestamptz DEFAULT now() NOT NULL,
  ADD COLUMN "deadline_at" timestamptz DEFAULT now() NOT NULL;

COMMENT ON COLUMN "kortix"."session_sandboxes"."active_since" IS
  'Start of this box''s current continuous running stretch. Anchor operand of the 24h absolute cap. Assigned ONLY by kortix.session_sandboxes_anchor_guard(); immutable while status = ''active''.';

COMMENT ON COLUMN "kortix"."session_sandboxes"."deadline_at" IS
  'When the control plane stops this box unless a control-plane-OBSERVED, non-sandbox-authored event moves it. Single writer: apps/api/src/projects/lifetime/deadline.ts (plus the two DB triggers). Bounded by deadline_at <= active_since + 24h.';
