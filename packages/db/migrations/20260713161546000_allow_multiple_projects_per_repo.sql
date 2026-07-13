-- A project is the isolation boundary for branch, secrets, connectors, access,
-- sessions, triggers, and deployments. Allow one Git repository to back
-- multiple independent projects, including projects on the same branch.

DROP INDEX IF EXISTS kortix.idx_projects_account_repo;

CREATE INDEX IF NOT EXISTS idx_projects_account_repo
  ON kortix.projects USING btree (account_id, repo_url);
