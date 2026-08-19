-- Reconcile Apps databases that applied the first Apps migration before
-- created_by was added to that migration file. Add immutable origin metadata.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."app_deployments"
  ADD COLUMN IF NOT EXISTS "created_by" uuid;
ALTER TABLE "kortix"."app_deployments"
  ADD COLUMN IF NOT EXISTS "source_session_id" text;
ALTER TABLE "kortix"."app_deployments"
  ADD COLUMN IF NOT EXISTS "actor_type" varchar(24);

UPDATE "kortix"."app_deployments" AS deployment
SET "created_by" = COALESCE(deployment."created_by", artifact."created_by", app."created_by")
FROM "kortix"."app_artifacts" AS artifact,
     "kortix"."apps" AS app
WHERE artifact."artifact_id" = deployment."artifact_id"
  AND app."app_id" = deployment."app_id"
  AND deployment."created_by" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "kortix"."app_deployments" WHERE "created_by" IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot reconcile app_deployments.created_by from artifact or App provenance';
  END IF;
END $$;

UPDATE "kortix"."app_deployments"
SET "actor_type" = 'human'
WHERE "actor_type" IS NULL;

ALTER TABLE "kortix"."app_deployments"
  ALTER COLUMN "actor_type" SET DEFAULT 'human';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_deployments_source_session_id_project_sessions_session_id_f'
      AND conrelid = 'kortix.app_deployments'::regclass
  ) THEN
    ALTER TABLE "kortix"."app_deployments"
      ADD CONSTRAINT "app_deployments_source_session_id_project_sessions_session_id_f"
      FOREIGN KEY ("source_session_id")
      REFERENCES "kortix"."project_sessions"("session_id")
      ON DELETE SET NULL
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_deployments_actor_type_check'
      AND conrelid = 'kortix.app_deployments'::regclass
  ) THEN
    ALTER TABLE "kortix"."app_deployments"
      ADD CONSTRAINT "app_deployments_actor_type_check"
      CHECK ("actor_type" IN ('human', 'agent', 'service_account', 'system'))
      NOT VALID;
  END IF;

  -- These validated checks let the cutover migration set the physical NOT NULL
  -- flags without scanning app_deployments while it holds an ACCESS EXCLUSIVE lock.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_deployments_created_by_not_null'
      AND conrelid = 'kortix.app_deployments'::regclass
  ) THEN
    ALTER TABLE "kortix"."app_deployments"
      ADD CONSTRAINT "app_deployments_created_by_not_null"
      CHECK ("created_by" IS NOT NULL)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_deployments_actor_type_not_null'
      AND conrelid = 'kortix.app_deployments'::regclass
  ) THEN
    ALTER TABLE "kortix"."app_deployments"
      ADD CONSTRAINT "app_deployments_actor_type_not_null"
      CHECK ("actor_type" IS NOT NULL)
      NOT VALID;
  END IF;
END $$;
