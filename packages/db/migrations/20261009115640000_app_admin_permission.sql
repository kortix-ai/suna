-- Migration: app_admin_permission
--
-- Kortix Backends become Apps of kind `convex`, so their two leaves fold into
-- the Apps leaves:
--
--   project.backend.read   -> project.app.read   (list, connect, mint a token)
--   project.backend.write  -> project.app.write  (snapshot, resize) and
--                             project.app.deploy (deploy)
--   NEW project.app.admin     reveal an App's admin credentials, rotate them,
--                             restore a snapshot, delete a `convex` App.
--
-- project.app.admin is granted to every role that holds project.app.write
-- (system and custom roles alike): the same roles 20261008200001000 gave
-- project.backend.write, so nobody gains or loses a power. In the seed that is
-- Manager. Then the two backend leaves and their grants go.
--
-- mixed-version-safe: the INSERTs are additive. The DELETEs remove leaves only
-- the retired /backends routes asserted; those routes stop existing with the
-- same deploy (20261009115639481 drops their table), and an old replica's
-- catalog loader drops actions it no longer finds. The leaves never reached
-- staging or prod (#9264 is dev-only).
--
-- backfill-safe: kortix.permissions (~80 rows) and kortix.role_permissions
-- (~125 rows plus custom roles). Catalog tables written only by migrations and
-- the role editor; each statement touches at most a few dozen rows under a 2 s
-- lock_timeout.

set lock_timeout = '2s';
set statement_timeout = '30s';

INSERT INTO kortix.permissions (action, scope_type, resource_type, delegable, area, level, description, implies)
VALUES
  ('project.app.admin', 'project', 'project', true, 'apps', 'edit',
   'Reveal and rotate an App''s admin credentials, restore a snapshot, and delete a backend App.',
   ARRAY['project.app.write']::text[])
ON CONFLICT (action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT rp.role_id, 'project.app.admin'
  FROM kortix.role_permissions rp
 WHERE rp.action = 'project.app.write'
ON CONFLICT (role_id, action) DO NOTHING;

DELETE FROM kortix.role_permissions WHERE action IN ('project.backend.read', 'project.backend.write');
DELETE FROM kortix.permissions WHERE action IN ('project.backend.read', 'project.backend.write');
