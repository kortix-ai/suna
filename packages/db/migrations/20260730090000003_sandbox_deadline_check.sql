-- Migration: sandbox_deadline_check
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- BOUNDED SANDBOX LIFETIME, step 4/7 -- THE CEILING, in the schema.
--
-- Every extension write in apps/api/src/projects/lifetime/deadline.ts already
-- wraps itself in LEAST(active_since + 24h, ...), so in normal operation this
-- constraint is UNREACHABLE. That is the point: it exists to catch a FUTURE
-- writer -- someone who adds an extension path in six months and does not know
-- the rule. Their first local test run throws 23514 instead of quietly
-- widening the maximum life of every sandbox on the platform.
--
-- It constrains a DIFFERENCE, which is only a ceiling because
-- 20260730090000005 makes the left operand (active_since) immutable while the
-- row is active. A CHECK on a difference with one operand under caller control
-- is not a ceiling -- it is a suggestion. The two migrations are one mechanism.
--
-- WHY 24 HOURS. Of 4,438 reconstructed turns over 30 days, 2 (0.05%) exceeded
-- 24h. A stop is non-destructive (the runtime identity is preserved, the
-- filesystem persists, and the resume path mints a fresh stretch), so the cost
-- of that 0.05% is one re-prompt. The literal is mirrored by
-- ABSOLUTE_RUN_CAP_MS in apps/api/src/projects/lifetime/constants.ts and the
-- two are pinned together by constants.test.ts, which reads THIS file.
--
-- NOT VALID here, VALIDATE in the next migration: the two-step is this repo's
-- established pattern (see ..._add_project_model_overrides +
-- ..._validate_project_model_overrides_check) and avoids taking an ACCESS
-- EXCLUSIVE full-table scan on the add. The backfill (step 3) ran first
-- precisely so the VALIDATE finds nothing to reject.
ALTER TABLE "kortix"."session_sandboxes"
  ADD CONSTRAINT "session_sandboxes_deadline_bounded"
  CHECK ("deadline_at" <= "active_since" + interval '24 hours') NOT VALID;
