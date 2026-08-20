-- Migration: rbac_project_credentials_issue
--
-- Adds ONE permission to the catalog: `project.credentials.issue`.
--
-- WHY. `POST|DELETE /v1/projects/:projectId/cli-token` and
-- `POST /v1/accounts/tokens` (with a project_id body) gate on
-- `loadProjectForUser(..., 'manage')`, and `manage` maps to `project.write`
-- (routes.md §5.1/§5.2). So minting a project CLI token — a credential that
-- OUTLIVES the request, is not bound to the minter, and grants the project's
-- full CLI surface — required nothing more than the ability to edit the
-- project. There was no leaf a custom role could withhold, and no leaf an
-- agent-session grant could be narrowed to.
--
-- The routes now pass the new `credentials` alias, which maps here.
--
-- mixed-version-safe: purely ADDITIVE. Old replicas never assert this action,
-- so the row is inert for them. New replicas assert it and find it seeded into
-- the Manager system role, which is exactly the set that held `project.write`
-- on those routes before — nobody who could mint a token yesterday loses the
-- ability today, and nobody gains it.
--
-- Seeded into `manager` only. Project `member` never held `project.write`, so
-- adding it there would be a widening.

-- backfill-safe: kortix.permissions (1 row) + kortix.iam_role_actions (1 row).
-- Both are catalog tables measured in tens of rows and written only by
-- migrations; no request path writes either, so no writer can queue behind
-- this. Two single-row INSERT … ON CONFLICT DO NOTHING, no scan, no lock held
-- beyond the row.

set lock_timeout = '2s';
set statement_timeout = '30s';

INSERT INTO kortix.permissions (action, scope_type, resource_type, delegable, area, level, description, implies)
VALUES (
  'project.credentials.issue',
  'project',
  'project',
  true,
  'tokens',
  'admin',
  'Mint or revoke a credential scoped to this project (a project CLI token, or a project-scoped personal access token).',
  ARRAY['project.read']::text[]
)
ON CONFLICT (action) DO NOTHING;

INSERT INTO kortix.iam_role_actions (role_id, action)
SELECT r.role_id, 'project.credentials.issue'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL
   AND r.key = 'manager'
   AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;
