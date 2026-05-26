-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Time-bounded V2 grants                                              ║
-- ║                                                                      ║
-- ║  Add optional auto-revoke timestamp to the two V2 grant tables:      ║
-- ║    project_members.expires_at    — per-user direct grant             ║
-- ║    project_group_grants.expires_at — per-group attachment             ║
-- ║                                                                      ║
-- ║  NULL = permanent (existing rows). When set and < now(), the V2      ║
-- ║  engine treats the row as if it didn't exist; a periodic sweeper     ║
-- ║  emits an audit event when it first observes the expiry. Rows are    ║
-- ║  left in place so the audit trail stays readable.                    ║
-- ║                                                                      ║
-- ║  Partial indexes on (expires_at) WHERE NOT NULL keep the sweeper     ║
-- ║  query cheap (only scans the small subset of bounded grants).        ║
-- ╚══════════════════════════════════════════════════════════════════════╝

ALTER TABLE kortix.project_members
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE kortix.project_group_grants
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_project_members_expires_at
  ON kortix.project_members (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_group_grants_expires_at
  ON kortix.project_group_grants (expires_at)
  WHERE expires_at IS NOT NULL;
