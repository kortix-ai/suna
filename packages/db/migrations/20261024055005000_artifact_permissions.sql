-- Migration: artifact_permissions
--
-- The four IAM leaves for artifacts (flag `artifacts`):
--   project.artifact.read     see the gallery, open an artifact, its versions and files
--   project.artifact.write    publish, share a Files folder, save, restore; rename and share your own
--   project.artifact.manage   rename, share or stop sharing anyone's artifact
--   project.artifact.public   give an artifact a public link (anyone with the link, no login)
-- Seeded so nobody loses what they could do before: read, write and public
-- into manager and member (they held project.read and project.session.start),
-- manage into manager (it held project.write). A custom role or an agent's
-- kortix_permissions gains them only when its owner adds them.
--
-- backfill-safe: kortix.permissions gets four catalog rows; kortix.role_permissions
-- gets at most seven built-in role rows. No user rows or hot tables are scanned.
set lock_timeout = '2s';
set statement_timeout = '30s';

INSERT INTO kortix.permissions
  (action, scope_type, resource_type, delegable, description, area, level, implies)
VALUES
  ('project.artifact.read', 'project', 'project', true,
   'View shared artifacts, their versions and files.', 'artifacts', 'view', '{}'::text[]),
  ('project.artifact.write', 'project', 'project', true,
   'Publish and edit artifacts, and share your own.', 'artifacts', 'edit', ARRAY['project.artifact.read']::text[]),
  ('project.artifact.manage', 'project', 'project', true,
   'Rename, share or stop sharing any artifact.', 'artifacts', 'edit', ARRAY['project.artifact.write']::text[]),
  ('project.artifact.public', 'project', 'project', true,
   'Share an artifact with a public link anyone can open.', 'artifacts', 'edit', '{}'::text[])
ON CONFLICT (action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'project.artifact.read'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL AND r.key = 'manager' AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'project.artifact.write'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL AND r.key = 'manager' AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'project.artifact.manage'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL AND r.key = 'manager' AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'project.artifact.public'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL AND r.key = 'manager' AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'project.artifact.read'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL AND r.key = 'member' AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'project.artifact.write'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL AND r.key = 'member' AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'project.artifact.public'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL AND r.key = 'member' AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;
