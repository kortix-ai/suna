-- A project is the isolation boundary for branch, secrets, connectors, access,
-- sessions, triggers, and deployments. Allow one Git repository to back
-- multiple independent projects, including projects on the same branch.

DROP INDEX IF EXISTS kortix.idx_projects_account_repo;

CREATE INDEX IF NOT EXISTS idx_projects_account_repo
  ON kortix.projects USING btree (account_id, repo_url);

-- The short-lived group branch-default experiment was deployed to dev before
-- the product model pivoted to independent projects. Keep its historical
-- migration append-only, then remove the abandoned column here.
ALTER TABLE kortix.project_group_grants
  DROP COLUMN IF EXISTS default_base_ref;
