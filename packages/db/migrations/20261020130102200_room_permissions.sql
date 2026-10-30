-- Migration: room_permissions
--
-- The two IAM leaves for rooms (flag `agent_rooms`):
--   project.room.read   list rooms, read their messages
--   project.room.write  create a room, post, put a session in or take it out
-- Seeded into the built-in roles that hold project.session.start (manager,
-- member): a post wakes other sessions, so it sits with starting one. A custom
-- role gains them only when its owner adds them.
--
-- backfill-safe: kortix.permissions gets two catalog rows; kortix.role_permissions
-- gets at most four built-in role rows. No user rows or hot tables are scanned.
set lock_timeout = '2s';
set statement_timeout = '30s';

INSERT INTO kortix.permissions
  (action, scope_type, resource_type, delegable, description, area, level, implies)
VALUES
  ('project.room.read', 'project', 'project', true,
   'View rooms and read their messages.', 'sessions', 'view', '{}'::text[]),
  ('project.room.write', 'project', 'project', true,
   'Create rooms, post messages, and put sessions in rooms.', 'sessions', 'edit', ARRAY['project.room.read']::text[])
ON CONFLICT (action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'project.room.read'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL AND r.key = 'manager' AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'project.room.write'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL AND r.key = 'manager' AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'project.room.read'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL AND r.key = 'member' AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'project.room.write'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL AND r.key = 'member' AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;
