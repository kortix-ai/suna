-- Make the project usage capability available to project-scoped grants.
-- backfill-safe: kortix.permissions has one catalog row per action; kortix.role_permissions
-- adds at most one built-in manager role row. No user rows or hot tables are scanned.
set lock_timeout = '2s';
set statement_timeout = '30s';

INSERT INTO kortix.permissions
  (action, scope_type, resource_type, delegable, description, area, level, implies)
VALUES
  ('project.usage.read', 'project', 'project', true,
   'View usage and costs for this project.', 'spend', 'view', '{}'::text[])
ON CONFLICT (action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'project.usage.read'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL AND r.key = 'manager' AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;
