-- Migration: capture_permissions
--
-- WHAT: two account-scope IAM leaves for Kortix Capture. Every account member
-- records and reads their own capture without a permission; these reach other
-- people:
--   capture.read_all  read every member's recordings (each read is audited)
--   capture.manage    turn Capture on or off, set the policy, revoke any device
-- Seeded into the system owner and admin roles. A custom role can grant them;
-- a PAT carries them through the person who minted it. Delegable.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- backfill-safe: catalog seed, not a backfill. Literal rows into
-- kortix.permissions (2 rows) and kortix.role_permissions (4 rows: 2 leaves x
-- owner and admin). Both are small catalog tables; nothing scans or rewrites
-- user data, and every statement is idempotent via ON CONFLICT.
--
-- Seeds the BASE TABLE kortix.role_permissions: kortix.iam_role_actions is a
-- view and cannot take ON CONFLICT (see 20260901124321557_git_ref_scopes.sql).
-- One statement per (role, action) so the apps/web role-capability-matrix
-- drift alarm can read the seed straight out of this file.

INSERT INTO kortix.permissions
  (action, scope_type, resource_type, delegable, description, area, level, implies)
VALUES
  ('capture.read_all', 'account', 'account', true,
   'Read every member''s Kortix Capture recordings.', 'capture', 'view',
   ARRAY[]::text[]),
  ('capture.manage', 'account', 'account', true,
   'Turn Kortix Capture on or off, set its policy, and revoke any device.', 'capture', 'edit',
   ARRAY[]::text[])
ON CONFLICT (action) DO NOTHING;

-- MUST run after the inserts above: role_permissions.action has an FK onto
-- permissions.action.
INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'capture.read_all'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL
   AND r.key = 'owner'
   AND r.scope_type = 'account'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'capture.manage'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL
   AND r.key = 'owner'
   AND r.scope_type = 'account'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'capture.read_all'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL
   AND r.key = 'admin'
   AND r.scope_type = 'account'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'capture.manage'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL
   AND r.key = 'admin'
   AND r.scope_type = 'account'
ON CONFLICT (role_id, action) DO NOTHING;
