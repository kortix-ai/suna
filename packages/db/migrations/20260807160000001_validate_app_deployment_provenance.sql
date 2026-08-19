set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."app_deployments"
  VALIDATE CONSTRAINT "app_deployments_source_session_id_project_sessions_session_id_f";
ALTER TABLE "kortix"."app_deployments"
  VALIDATE CONSTRAINT "app_deployments_actor_type_check";
ALTER TABLE "kortix"."app_deployments"
  VALIDATE CONSTRAINT "app_deployments_created_by_not_null";
ALTER TABLE "kortix"."app_deployments"
  VALIDATE CONSTRAINT "app_deployments_actor_type_not_null";
