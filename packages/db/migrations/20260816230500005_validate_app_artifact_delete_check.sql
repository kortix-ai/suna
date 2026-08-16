-- Migration: validate_app_artifact_delete_check
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."app_deployments"
  VALIDATE CONSTRAINT "app_deployments_artifact_id_app_artifacts_artifact_id_fk";
