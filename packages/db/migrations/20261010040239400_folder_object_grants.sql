-- Migration: folder_object_grants
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Folder access in a project's Files is the project's ordinary object grants:
-- one `kortix.role_assignments` row per (principal, folder) with object type
-- `folder`, the folder path as object id, and one of three system roles that
-- carry no permissions (an object grant narrows, it never adds):
-- `folder-reader`, `folder-writer`, `folder-manager`.
--
-- backfill-safe: kortix.object_policies (7 rows) and kortix.roles (system rows
-- plus a handful of custom roles per account) get one and three seed rows; both
-- are read through long-TTL memos and written only by migrations and the roles
-- admin page, so no writer queues behind the inserts. ON CONFLICT / NOT EXISTS.

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
