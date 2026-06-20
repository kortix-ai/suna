-- Trigger observability: record the OUTCOME of each trigger's most recent
-- attempt so "why isn't my trigger running?" is answerable from the triggers
-- API/UI instead of vanishing into the scheduler logs. last_status is
-- 'fired' | 'queued' | 'failed'; last_error holds the failure / parse-error
-- reason; last_attempt_at is when that attempt happened (distinct from
-- last_fired_at, which only advances on a successful or queued fire, so a
-- failing trigger keeps a stale last_fired_at but a fresh last_attempt_at +
-- last_error). See apps/api/src/projects/lib/triggers.ts (markGitTriggerFired,
-- markGitTriggerAttemptFailed, loadTriggersForResponse).
ALTER TABLE "kortix"."project_trigger_runtime"
  ADD COLUMN IF NOT EXISTS "last_status" varchar(32);

ALTER TABLE "kortix"."project_trigger_runtime"
  ADD COLUMN IF NOT EXISTS "last_error" text;

ALTER TABLE "kortix"."project_trigger_runtime"
  ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamptz;
