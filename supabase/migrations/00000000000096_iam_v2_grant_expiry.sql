-- Cross-account sharing via "external" account_members rows. The engine
-- treats them identically to regular members (same policy + group
-- lookups), but the UI surfaces them separately and they carry an
-- optional auto-revoke timestamp + grant note.

ALTER TABLE "kortix"."account_members"
  ADD COLUMN IF NOT EXISTS "is_external"                  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "external_grant_expires_at"    timestamptz,
  ADD COLUMN IF NOT EXISTS "external_granted_by"          uuid,
  ADD COLUMN IF NOT EXISTS "external_note"                text;

-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Time-bounded V2 grants (project_members)                            ║
-- ║                                                                      ║
-- ║  Add optional auto-revoke timestamp to project_members (direct       ║
-- ║  per-user grants). project_group_grants.expires_at is added in       ║
-- ║  00000000000084_iam_v2_project_group_grants.sql when that table is   ║
-- ║  created.                                                            ║
-- ║                                                                      ║
-- ║  NULL = permanent (existing rows). When set and < now(), the V2      ║
-- ║  engine treats the row as if it didn't exist; a periodic sweeper     ║
-- ║  emits an audit event when it first observes the expiry. Rows are    ║
-- ║  left in place so the audit trail stays readable.                    ║
-- ║                                                                      ║
-- ║  Partial index on (expires_at) WHERE NOT NULL keeps the sweeper      ║
-- ║  query cheap (only scans the small subset of bounded grants).        ║
-- ╚══════════════════════════════════════════════════════════════════════╝

ALTER TABLE kortix.project_members
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_project_members_expires_at
  ON kortix.project_members (expires_at)
  WHERE expires_at IS NOT NULL;
