-- Add Git-backed-project linkage + adapter-provider tag to the deployments
-- table so the new /v1/projects/:id/apps path can register and re-deploy
-- entries declared as [[apps]] inside kortix.toml.
--
-- All columns are nullable so the legacy /v1/deployments route (which has
-- no project context) keeps writing exactly the same shape it did before.
ALTER TABLE "kortix"."deployments" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."deployments" ADD COLUMN "app_slug" varchar(128);--> statement-breakpoint
ALTER TABLE "kortix"."deployments" ADD COLUMN "provider" varchar(32);--> statement-breakpoint
-- Drives the per-project apps view and the auto-deploy sweep lookup
-- ("latest deployment for this (project, slug)"). Includes created_at so
-- the index also satisfies the ORDER BY in the sweep query.
CREATE INDEX "idx_deployments_project_app" ON "kortix"."deployments" USING btree ("project_id","app_slug","created_at");
