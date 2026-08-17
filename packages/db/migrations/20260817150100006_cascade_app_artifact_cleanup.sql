-- Migration: cascade_app_artifact_cleanup
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Project deletion cascades through both Apps and App artifacts. Cascading an
-- artifact's deployments removes the ordering dependency between those paths.
-- The API never hard-deletes an artifact independently; it changes its status.
-- mixed-version-safe: all API versions preserve App artifacts as rows.
ALTER TABLE "kortix"."app_deployments"
  DROP CONSTRAINT "app_deployments_artifact_id_app_artifacts_artifact_id_fk";--> statement-breakpoint
ALTER TABLE "kortix"."app_deployments"
  ADD CONSTRAINT "app_deployments_artifact_id_app_artifacts_artifact_id_fk"
  FOREIGN KEY ("artifact_id")
  REFERENCES "kortix"."app_artifacts"("artifact_id")
  ON DELETE CASCADE
  NOT VALID;
