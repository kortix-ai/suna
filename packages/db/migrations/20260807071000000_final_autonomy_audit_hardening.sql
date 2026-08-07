-- Migration: final_autonomy_audit_hardening
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEW THE GENERATED SQL BELOW. drizzle-kit writes it from the diff between
-- kortix.ts and the snapshot; it knows the target shape, not how to reach it
-- without downtime. Check the same list `migrate:create` prints:
--   [ ] Bare NOT NULL added to an existing populated table (needs a backfill first).
--   [ ] Plain CREATE INDEX / DROP INDEX on an EXISTING table -- move it to
--       `pnpm migrate:create <slug> --concurrent`; it blocks writes here.
--   [ ] New FK/constraint on an existing table -- add NOT VALID, VALIDATE after.
--   [ ] A DROP/RENAME/ALTER ... TYPE the generator proposed from a STALE
--       snapshot. Delete anything already applied by an earlier migration.
--   [ ] Any DROP/RENAME/ALTER ... TYPE/DROP NOT NULL needs the enforced line:
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

CREATE TABLE "kortix"."project_task_turn_outcomes" (
  "project_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "settlement_id" text NOT NULL,
  "claim_session_id" text NOT NULL,
  "worker_session_id" text NOT NULL,
  "outcome" varchar(16) NOT NULL,
  "task_snapshot" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_task_turn_outcomes_task_id_settlement_id_pk" PRIMARY KEY("task_id","settlement_id"),
  CONSTRAINT "project_task_turn_outcomes_id_nonempty" CHECK (btrim("settlement_id") <> ''),
  CONSTRAINT "project_task_turn_outcomes_outcome_valid" CHECK ("outcome" in ('progress', 'no_progress')),
  CONSTRAINT "project_task_turn_outcomes_snapshot_valid" CHECK (("outcome" = 'progress') = ("task_snapshot" is not null)),
  CONSTRAINT "project_task_turn_outcomes_task_fkey"
    FOREIGN KEY ("project_id","task_id")
    REFERENCES "kortix"."project_tasks"("project_id","task_id") ON DELETE cascade
);
CREATE INDEX "idx_project_task_turn_outcomes_project"
  ON "kortix"."project_task_turn_outcomes" ("project_id");

ALTER TABLE "kortix"."project_tasks"
  ADD COLUMN "liveness_turn_id" uuid;
ALTER TABLE "kortix"."project_tasks"
  ADD CONSTRAINT "project_tasks_turn_requires_doing_worker"
  CHECK (liveness_turn_id is null or (status = 'doing' and liveness_worker_session_id is not null))
  NOT VALID;

-- mixed-version-safe: lifecycle commands retain evaluations by idempotency key;
-- old code tolerates the nullable identifier without database-level retention.
ALTER TABLE "kortix"."project_goal_evaluations"
  DROP CONSTRAINT IF EXISTS "project_goal_evaluations_lifecycle_command_fkey";
ALTER TABLE "kortix"."project_goal_evaluations"
  ADD COLUMN "fired_at" timestamp with time zone;

-- mixed-version-safe: old API pods do not write fired_at and old lifecycle
-- workers do not settle linked evaluations. Database triggers preserve the
-- invariant and both command/evaluation race orders throughout a rolling deploy.
CREATE OR REPLACE FUNCTION "kortix"."normalize_goal_evaluation_delivery"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  command_status text;
  command_updated_at timestamptz;
  command_session_id text;
BEGIN
  IF NEW.lifecycle_command_id IS NOT NULL THEN
    SELECT status::text, updated_at, session_id
      INTO command_status, command_updated_at, command_session_id
    FROM kortix.session_lifecycle_commands
    WHERE command_id = NEW.lifecycle_command_id;
    IF command_status = 'succeeded' THEN
      NEW.state := 'fired';
      NEW.fired_at := coalesce(NEW.fired_at, command_updated_at);
      NEW.session_id := coalesce(NEW.session_id, command_session_id);
    ELSIF command_status IN ('failed', 'dead_lettered') THEN
      NEW.state := 'failed';
      NEW.fired_at := null;
    END IF;
  END IF;
  IF NEW.state = 'fired' THEN
    NEW.fired_at := coalesce(NEW.fired_at, NEW.updated_at, now());
  ELSE
    NEW.fired_at := null;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_goal_evaluation_normalize_delivery
BEFORE INSERT OR UPDATE ON "kortix"."project_goal_evaluations"
FOR EACH ROW EXECUTE FUNCTION "kortix"."normalize_goal_evaluation_delivery"();

CREATE OR REPLACE FUNCTION "kortix"."settle_goal_evaluation_from_lifecycle"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'succeeded' THEN
    UPDATE kortix.project_goal_evaluations
    SET state = 'fired',
        fired_at = coalesce(fired_at, NEW.updated_at),
        session_id = coalesce(session_id, NEW.session_id),
        updated_at = greatest(updated_at, NEW.updated_at)
    WHERE lifecycle_command_id = NEW.command_id AND state = 'queued';
  ELSIF NEW.status IN ('failed', 'dead_lettered') THEN
    UPDATE kortix.project_goal_evaluations
    SET state = 'failed', fired_at = null,
        updated_at = greatest(updated_at, NEW.updated_at)
    WHERE lifecycle_command_id = NEW.command_id AND state = 'queued';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_lifecycle_settle_goal_evaluation
AFTER UPDATE OF status ON "kortix"."session_lifecycle_commands"
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION "kortix"."settle_goal_evaluation_from_lifecycle"();

-- Reconcile deliveries completed before this column existed. The durable command
-- completion timestamp is the only authoritative historical delivery order.
UPDATE "kortix"."project_goal_evaluations" AS evaluation
SET state = 'fired',
    fired_at = command.updated_at,
    session_id = coalesce(evaluation.session_id, command.session_id),
    updated_at = greatest(evaluation.updated_at, command.updated_at)
FROM "kortix"."session_lifecycle_commands" AS command
WHERE evaluation.lifecycle_command_id = command.command_id
  AND evaluation.state = 'queued'
  AND command.status = 'succeeded';
UPDATE "kortix"."project_goal_evaluations" AS evaluation
SET state = 'failed', fired_at = null, updated_at = greatest(evaluation.updated_at, command.updated_at)
FROM "kortix"."session_lifecycle_commands" AS command
WHERE evaluation.lifecycle_command_id = command.command_id
  AND evaluation.state = 'queued'
  AND command.status IN ('failed', 'dead_lettered');
UPDATE "kortix"."project_goal_evaluations"
SET fired_at = coalesce(fired_at, updated_at, created_at)
WHERE state = 'fired';

ALTER TABLE "kortix"."project_goal_evaluations"
  ADD CONSTRAINT "project_goal_evaluations_fired_at_valid"
  CHECK ((state = 'fired') = (fired_at is not null)) NOT VALID;

-- Old no-progress writers participate in the new exactly-one-outcome ledger
-- during a rolling deploy. An opposite progress outcome aborts the old write.
CREATE OR REPLACE FUNCTION "kortix"."mirror_no_progress_turn_outcome"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE existing_outcome text;
BEGIN
  SELECT outcome INTO existing_outcome
  FROM kortix.project_task_turn_outcomes
  WHERE task_id = NEW.task_id AND settlement_id = NEW.settlement_id;
  IF existing_outcome = 'progress' THEN
    RAISE EXCEPTION 'turn outcome already recorded as progress'
      USING ERRCODE = '23505';
  END IF;
  IF existing_outcome = 'no_progress' THEN
    RETURN NEW;
  END IF;
  INSERT INTO kortix.project_task_turn_outcomes (
    project_id, task_id, settlement_id, claim_session_id,
    worker_session_id, outcome, task_snapshot, created_at
  ) VALUES (
    NEW.project_id, NEW.task_id, NEW.settlement_id, NEW.claim_session_id,
    NEW.worker_session_id, 'no_progress', null, NEW.created_at
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_task_no_progress_mirror_turn_outcome
BEFORE INSERT ON "kortix"."project_task_no_progress_settlements"
FOR EACH ROW EXECUTE FUNCTION "kortix"."mirror_no_progress_turn_outcome"();

INSERT INTO "kortix"."project_task_turn_outcomes" (
  project_id, task_id, settlement_id, claim_session_id,
  worker_session_id, outcome, task_snapshot, created_at
)
SELECT project_id, task_id, settlement_id, claim_session_id,
       worker_session_id, 'no_progress', null, created_at
FROM "kortix"."project_task_no_progress_settlements"
ON CONFLICT (task_id, settlement_id) DO NOTHING;
