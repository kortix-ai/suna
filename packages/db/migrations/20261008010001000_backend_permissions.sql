-- Migration: backend_permissions
--
-- WHY. A project can own N self-hosted Convex backends ("Kortix Backends"), one
-- microVM each. Two new project leaves govern them, named after the topic like
-- the Apps leaves:
--
--   project.backend.read   list and inspect the project's backends (name, status, URL)
--   project.backend.write  create and delete backends, and read a backend's admin
--                          credentials (the admin key grants full control of the
--                          backend's data and code, so it is the deploy-level leaf)
--
-- Grants mirror Apps exactly: every role that holds project.app.read gets
-- project.backend.read, and every role that holds project.app.write gets
-- project.backend.write (system and custom roles alike). In the seed that is
-- Manager (both) and Member (read).
--
-- A fresh database runs every migration in order, so this file alone seeds the
-- two rows and their grants; no edit to the canonical-model seed is needed.
--
-- mixed-version-safe: purely ADDITIVE (INSERT ... ON CONFLICT DO NOTHING). Old
-- replicas never assert these leaves, and their catalog loader drops actions the
-- code does not know. New replicas find the leaves granted to the same roles
-- that hold the matching Apps leaves.

-- backfill-safe: kortix.permissions (~80 rows) and kortix.role_permissions (~125
-- rows). Catalog tables written only by migrations and the role editor; the
-- INSERT ... SELECT touches at most a few dozen rows under a 2 s lock_timeout.

set lock_timeout = '2s';
set statement_timeout = '30s';

INSERT INTO kortix.permissions (action, scope_type, resource_type, delegable, area, level, description, implies)
VALUES
  ('project.backend.read', 'project', 'project', true, 'backends', 'view',
   'View the project''s Backends: name, status and URL.',
   ARRAY[]::text[]),
  ('project.backend.write', 'project', 'project', true, 'backends', 'edit',
   'Create and delete Backends, and read a Backend''s admin credentials.',
   ARRAY['project.backend.read']::text[])
ON CONFLICT (action) DO NOTHING;

-- Same roles as Apps: app.read -> backend.read, app.write -> backend.write.
INSERT INTO kortix.role_permissions (role_id, action)
SELECT rp.role_id, 'project.backend.read'
  FROM kortix.role_permissions rp
 WHERE rp.action = 'project.app.read'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT rp.role_id, 'project.backend.write'
  FROM kortix.role_permissions rp
 WHERE rp.action = 'project.app.write'
ON CONFLICT (role_id, action) DO NOTHING;
