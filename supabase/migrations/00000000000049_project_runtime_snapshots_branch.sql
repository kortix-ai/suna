-- Per-project runtime snapshots: track which branch the snapshot was built
-- for, so the API can look up the latest ready snapshot for the project's
-- default branch (and prune everything else with a clear retention policy).
--
-- Pre-existing rows (built by the older lazy-fallback path that didn't
-- record the branch) are backfilled from the owning project's
-- default_branch so the "latest ready for default branch" lookup includes
-- them — otherwise every existing project would think it has no snapshot
-- and refuse new sessions until a fresh build lands.

ALTER TABLE "kortix"."project_runtime_snapshots"
  ADD COLUMN IF NOT EXISTS "branch" text NOT NULL DEFAULT '';

UPDATE "kortix"."project_runtime_snapshots" snap
SET "branch" = p."default_branch"
FROM "kortix"."projects" p
WHERE snap."project_id" = p."project_id"
  AND snap."branch" = '';

CREATE INDEX IF NOT EXISTS "idx_project_runtime_snapshots_branch_ready"
  ON "kortix"."project_runtime_snapshots" ("project_id", "branch", "status", "created_at" DESC);
