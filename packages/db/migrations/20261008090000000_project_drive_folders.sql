-- Migration: project_drive_folders
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- One drive per project, shown as Files, with access per folder.
--
-- 1. `kortix.drives.kind` gains `project`, one row per project. The earlier
--    kinds stay valid: their rows are folded into project drives by a job
--    (apps/api/src/drives/fold.ts) and stay until an operator retires them.
-- 2. Folder access is the project's ordinary object grants: one
--    `kortix.role_assignments` row per (principal, folder) with object type
--    `folder`, the folder path as object id, and one of three system roles
--    that carry no permissions (an object grant narrows, it never adds):
--    `folder-reader`, `folder-writer`, `folder-manager`.
--
-- mixed-version-safe: the kind CHECK is replaced by a strict superset (every
-- value the old one accepted is still accepted) in one transaction, so no
-- running API version can write a row the new constraint rejects. The unique
-- index is on a table with at most a few rows per account (created by the
-- 20261004082211000 drives migration days earlier), so a plain CREATE INDEX
-- blocks nothing. The role and policy rows are seeds, ON CONFLICT / NOT EXISTS.
--
-- backfill-safe: kortix.object_policies (7 rows) and kortix.roles (system rows
-- plus a handful of custom roles per account) get one and three seed rows; both
-- are read through long-TTL memos and written only by migrations and the roles
-- admin page, so no writer queues behind the inserts.

ALTER TABLE kortix.drives DROP CONSTRAINT drives_kind;
ALTER TABLE kortix.drives
  ADD CONSTRAINT drives_kind CHECK (kind in ('personal', 'agent', 'company', 'project'));

CREATE UNIQUE INDEX IF NOT EXISTS drives_one_per_project
  ON kortix.drives USING btree (project_id)
  WHERE kind = 'project';

INSERT INTO kortix.object_policies (object_type, unscoped_default_for_member, description) VALUES
  ('folder', 'closed', 'A folder of the project''s Files. Reached only through a grant on it or a folder above it; project admins manage every folder but people''s own.')
ON CONFLICT (object_type) DO NOTHING;

INSERT INTO kortix.roles (account_id, key, name, description, scope_type, is_system)
SELECT * FROM (VALUES
  (NULL::uuid, 'folder-reader',  'Folder: read',   'Object grant on a Files folder: read it and everything below it.', 'project', true),
  (NULL::uuid, 'folder-writer',  'Folder: write',  'Object grant on a Files folder: read and change files in it.',     'project', true),
  (NULL::uuid, 'folder-manager', 'Folder: manage', 'Object grant on a Files folder: change files and who has access.', 'project', true)
) AS v(account_id, key, name, description, scope_type, is_system)
WHERE NOT EXISTS (
  SELECT 1 FROM kortix.roles r
   WHERE r.account_id IS NULL AND r.key = v.key AND r.scope_type = v.scope_type
);
