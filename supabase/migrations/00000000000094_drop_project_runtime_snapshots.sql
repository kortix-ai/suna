-- Snapshot system refactor: stateless boot + append-only build log.
--
-- The old `project_runtime_snapshots` table tried to mirror Daytona's snapshot
-- state in our DB so boot could short-circuit a registry lookup. That mirror
-- drifted (TTLs, manual deletes, regional purges) and produced the
-- "Snapshot kortix-snap-… not found" boot crash. Refactor:
--
--   1. Session boot is now stateless: compute the content-addressed snapshot
--      name from (Dockerfile, git tree OID, runtime fingerprint, spec), then
--      ask Daytona. Build inline if missing. No DB read on the hot path.
--   2. A new append-only log (`project_snapshot_builds`) records every build
--      attempt for UI: history, the failure error string for "fix with agent",
--      and proactive pre-build tracking. NEVER consulted on boot, so it can
--      drift from Daytona without breaking sessions.

DROP TABLE IF EXISTS kortix.project_runtime_snapshots CASCADE;
DROP TYPE IF EXISTS kortix.project_snapshot_status;

CREATE TABLE IF NOT EXISTS kortix.project_snapshot_builds (
  build_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT '',
  snapshot_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
  error TEXT,
  error_category TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_project_snapshot_builds_project_recent
  ON kortix.project_snapshot_builds(project_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_snapshot_builds_status
  ON kortix.project_snapshot_builds(project_id, status, started_at DESC);
