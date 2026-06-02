-- ============================================================================
-- 00000000000106  git_proxy_upstream
-- Managed-git proxy refactor: a project's git connection now distinguishes the
-- client-facing Kortix git-proxy URL (project_git_connections.repo_url /
-- projects.repo_url) from the REAL upstream host URL.
--
--   upstream_url  — real host git URL (github.com/…, git.freestyle.sh/…). The
--                   proxy + server-side git resolve the host through this;
--                   clients never see it. NULL on legacy rows → callers fall
--                   back to repo_url (which, pre-refactor, IS the real URL).
--   managed       — true when Kortix provisioned the repo (vs a BYO/linked repo).
--
-- Additive + idempotent (matches the drizzle-push columns in
-- packages/db/src/schema/kortix.ts). Guarded so it's a no-op once push or a
-- prior run already added the columns.
-- ============================================================================

ALTER TABLE kortix."project_git_connections"
  ADD COLUMN IF NOT EXISTS "upstream_url" text;

ALTER TABLE kortix."project_git_connections"
  ADD COLUMN IF NOT EXISTS "managed" boolean NOT NULL DEFAULT false;
