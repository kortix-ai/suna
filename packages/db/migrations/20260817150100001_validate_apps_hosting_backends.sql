-- Migration: validate_apps_hosting_backends
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."app_deployments"
  VALIDATE CONSTRAINT "app_deployments_hosting_type_check";--> statement-breakpoint
ALTER TABLE "kortix"."app_runtimes"
  VALIDATE CONSTRAINT "app_runtimes_hosting_type_not_null";--> statement-breakpoint
ALTER TABLE "kortix"."app_runtimes"
  VALIDATE CONSTRAINT "app_runtimes_hosting_type_check";--> statement-breakpoint
ALTER TABLE "kortix"."app_runtimes"
  VALIDATE CONSTRAINT "app_runtimes_auth_material_check";
--> statement-breakpoint
ALTER TABLE "kortix"."sandbox_compute_sessions"
  VALIDATE CONSTRAINT "sandbox_compute_sessions_compute_provider_check";
