-- Migration: share_access_project_principal
--
-- Two additions to the one grant store, `kortix.role_assignments`:
--
-- 1. Principal kind `project` — "everyone who has access to this project".
--    It exists only as an OBJECT grant: the `agent-user` role, project scope,
--    naming one agent or one connection, with `principal_id = scope_id`.
--    `resolvePrincipal` loads assignments by user and group id, so a `project`
--    row is never read as a role and can never grant a permission. The shape
--    check below makes that the storage rule for every writer, not only the API.
--
-- 2. Object type `connection` — a project-owned connector account
--    (`connector_connections.connection_id`). A shared account with no
--    `connection` grant stays usable by the whole project, as today; one or
--    more grants narrow it to the named groups and members.
--
-- Both CHECKs are added NOT VALID (a catalog update, no scan);
-- 20260926172248001_share_access_project_principal_validate.sql validates them.
--
-- mixed-version-safe: the principal-type CHECK is replaced by a strict
-- superset — every value the old one accepted ('user', 'group',
-- 'service_account', 'pending') is still accepted, so no running API version
-- can write a row the new constraint rejects. The new shape CHECK constrains
-- only `project` rows, which no pre-change API version writes. The drop and
-- the add run in one transaction, so no window exists without a principal-type
-- check.
--
-- backfill-safe: kortix.object_policies is a 5-row lookup table read only by
-- the IAM engine; the one INSERT below is a seed row, ON CONFLICT DO NOTHING,
-- and no writer queues behind it.

set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.role_assignments
  DROP CONSTRAINT role_assignments_principal_type_check;

ALTER TABLE kortix.role_assignments
  ADD CONSTRAINT role_assignments_principal_type_check
  CHECK ("principal_type" IN ('user','group','service_account','pending','project'))
  NOT VALID;

-- A `project` principal is an object grant on its own project, and nothing else.
ALTER TABLE kortix.role_assignments
  ADD CONSTRAINT role_assignments_project_principal_shape_check
  CHECK (
    "principal_type" <> 'project'
    OR ("object_type" IS NOT NULL AND "scope_type" = 'project' AND "principal_id" = "scope_id")
  )
  NOT VALID;

INSERT INTO kortix.object_policies (object_type, unscoped_default_for_member, description) VALUES
  ('connection', 'open', 'A shared connector account nobody scoped stays usable by the whole project. Grants narrow it to the named groups and members.')
ON CONFLICT (object_type) DO NOTHING;
