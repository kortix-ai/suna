-- Migration: defer_app_artifact_delete_check
set lock_timeout = '2s';
set statement_timeout = '30s';

-- RESTRICT runs before sibling project cascades and prevents a project from
-- deleting its Apps, deployments, and artifacts in one statement. NO ACTION
-- keeps standalone artifact deletion blocked while checking after cascades.
-- mixed-version-safe: the API does not hard-delete App artifacts or deployments.
ALTER TABLE "kortix"."app_deployments"
  DROP CONSTRAINT "app_deployments_artifact_id_app_artifacts_artifact_id_fk";--> statement-breakpoint
ALTER TABLE "kortix"."app_deployments"
  ADD CONSTRAINT "app_deployments_artifact_id_app_artifacts_artifact_id_fk"
  FOREIGN KEY ("artifact_id")
  REFERENCES "kortix"."app_artifacts"("artifact_id")
  ON DELETE NO ACTION
  NOT VALID;
