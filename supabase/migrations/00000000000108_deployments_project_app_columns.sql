-- Experimental [[apps]] deployment surface: link a deployment back to a
-- Git-backed project + the app slug inside its kortix.toml, and record the
-- provider that produced it. These columns post-date the original
-- deployments table in bootstrap.sql; without this migration a DB built
-- from the committed migrations is missing them and GET /v1/projects/:id/apps
-- 500s once apps is enabled. Matches packages/db/src/schema/kortix.ts.
ALTER TABLE kortix.deployments
  ADD COLUMN IF NOT EXISTS project_id uuid;
ALTER TABLE kortix.deployments
  ADD COLUMN IF NOT EXISTS app_slug varchar(128);
ALTER TABLE kortix.deployments
  ADD COLUMN IF NOT EXISTS provider varchar(32);

-- Drives the project-apps list view + the auto-deploy sweep lookup
-- ("latest deployment for this (project, slug)").
CREATE INDEX IF NOT EXISTS idx_deployments_project_app
  ON kortix.deployments (project_id, app_slug, created_at);
