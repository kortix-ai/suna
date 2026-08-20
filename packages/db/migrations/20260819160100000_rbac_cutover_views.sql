-- Migration: rbac_cutover_views
--
-- CUTOVER STEP 2 OF 2 — the step that makes `kortix.role_assignments` the ONLY
-- authorization store. Everything the engine used to be able to read from lives
-- in it; this migration flips which side of every pair is physical.
--
--   name                                today          after this file
--   ---------------------------------   ------------   -------------------------
--   kortix.roles                        view           TABLE
--   kortix.role_permissions             view           TABLE
--   kortix.group_members                view           TABLE
--   kortix.project_members              table          view over role_assignments
--   kortix.project_group_grants         table          view over role_assignments
--   kortix.iam_policies                 table          view over role_assignments
--   kortix.iam_resource_grants          table          view over role_assignments
--   kortix.account_members              table          view (identity table +
--                                                      derived account_role)
--   kortix.account_memberships          -              TABLE (the identity half)
--
-- WHY VIEWS AND NOT DROPS
-- A DROP would 42P01 every read a pre-cutover replica issues for the minutes a
-- rolling deploy has both images live, and there are non-engine read sites that
-- SELECT these columns directly rather than through a helper. Keeping the legacy
-- NAMES as views over the canonical store means an old replica keeps reading
-- exactly what it read before, and reads the SAME rows the new engine decides
-- on. The drops are a later release (migrations-pending/README.md).
--
-- WHY INSTEAD OF TRIGGERS AND NOT AUTO-UPDATABLE VIEWS
-- migrations-pending/README.md assumed the legacy shapes would be auto-updatable
-- single-table views, so a straggler WRITE would land in the canonical store on
-- its own. Three of the five cannot be:
--   * project_members / project_group_grants / iam_policies must JOIN the role
--     table to render the legacy `project_role` / `role` / custom-role columns,
--     and a view with a join is not auto-updatable at all;
--   * iam_resource_grants renders `effect` and `principal_type` as expressions,
--     which are not assignable columns even on an otherwise auto-updatable view;
--   * account_members renders account_role from a subquery, same problem.
--   * Measured, not assumed: `INSERT ... ON CONFLICT (cols) DO UPDATE` against a
--     view fails with "there is no unique or exclusion constraint matching the
--     ON CONFLICT specification" — a view has no indexes — and five production
--     write sites use exactly that shape.
-- So each legacy name gets INSTEAD OF INSERT/UPDATE/DELETE triggers that write
-- kortix.role_assignments. They are the same one-way legacy->canonical mapping
-- the dual-write mirror (20260819015728000) performed, moved from AFTER triggers
-- on a second physical table to INSTEAD OF triggers on a view of the only one.
-- The five ON CONFLICT write sites are additionally rewired to `assignRole()` in
-- the same PR; the triggers exist for everything this migration cannot see —
-- a pre-cutover replica mid-roll, a support script, pg_restore, a test fixture.
--
-- mixed-version-safe: this is the CONTRACT step of expand/contract, and every
-- flagged operation is deliberate.
--   1. DROP TABLE project_members / project_group_grants / iam_policies /
--      iam_resource_grants. Safe ONLY because their content already lives in
--      role_assignments and is re-verified immediately before this migration by
--      20260819160000000_rbac_cutover_backfill.concurrent.ts plus
--      `bun apps/api/scripts/rbac-cutover-audit.ts`, which exits non-zero if a
--      single legacy row has no canonical counterpart. Every legacy NAME
--      survives with a byte-identical column list and column ORDER, so an old
--      replica's SELECT, INSERT, UPDATE and DELETE all still work.
--   2. ALTER TABLE account_members RENAME TO account_memberships + DROP COLUMN
--      account_role. The name `account_members` immediately reappears as a view
--      carrying every column the table had, account_role included (derived).
--      No deployed code can tell the difference; `is_super_admin`,
--      `scim_external_id` and `joined_at` stay physical (spec §1).
--   3. ALTER TABLE iam_roles RENAME TO roles (+ is_builtin -> is_system),
--      iam_role_actions -> role_permissions, account_group_members ->
--      group_members. All three old names reappear as auto-updatable
--      single-table views with the original column names, so old readers AND
--      old writers are unaffected (verified: INSERT, INSERT..ON CONFLICT with
--      and without a target, UPDATE and DELETE all pass through a simple
--      single-table view).
--   4. DROP TABLE sandbox_member_scopes / sandbox_invites / connector_grants /
--      session_folder_grants. 0 rows in every environment and 0 code references
--      outside the drizzle schema declarations this PR also removes.
--      kortix.sandbox_members is deliberately NOT dropped: it has 0 rows but is
--      still read and written by apps/api/src/router/services/member-spend.ts
--      (the per-member LLM spend cap), so dropping it would 42P01 the proxy.
--      That is a billing surface, not an RBAC one, and it is out of scope here.
--   5. DROP the 15 dual-write mirror triggers. Their whole purpose was to keep a
--      SECOND physical store in step; after this file there is no second store.
--      Leaving them would be worse than useless — they would fire on the views'
--      INSTEAD OF triggers' own writes.
--
-- backfill-safe: no top-level DML. The only data statements in this file live
-- inside dollar-quoted trigger-function bodies and run per row at request time,
-- never as a pass over a table.

-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Every statement here is a catalog operation: renames, column drops, table
-- drops of tables whose rows have already been migrated, view creates, and one
-- NOT VALID constraint. None scans a table, so 60s is a generous ceiling and 3s
-- of lock wait is the usual house budget for DDL that must not queue behind a
-- long reader.
set lock_timeout = '3s';
set statement_timeout = '60s';

-- ─── 1. Retire the dual-write mirror ────────────────────────────────────────
-- Triggers first, then their functions: the account_members functions reference
-- NEW.account_role, which section 6 drops.

DROP TRIGGER IF EXISTS trg_rbac_mirror_account_members_ins ON kortix.account_members;
DROP TRIGGER IF EXISTS trg_rbac_mirror_account_members_upd ON kortix.account_members;
DROP TRIGGER IF EXISTS trg_rbac_mirror_account_members_del ON kortix.account_members;
DROP TRIGGER IF EXISTS trg_rbac_mirror_project_members_ins ON kortix.project_members;
DROP TRIGGER IF EXISTS trg_rbac_mirror_project_members_upd ON kortix.project_members;
DROP TRIGGER IF EXISTS trg_rbac_mirror_project_members_del ON kortix.project_members;
DROP TRIGGER IF EXISTS trg_rbac_mirror_group_grants_ins ON kortix.project_group_grants;
DROP TRIGGER IF EXISTS trg_rbac_mirror_group_grants_upd ON kortix.project_group_grants;
DROP TRIGGER IF EXISTS trg_rbac_mirror_group_grants_del ON kortix.project_group_grants;
DROP TRIGGER IF EXISTS trg_rbac_mirror_iam_policies_ins ON kortix.iam_policies;
DROP TRIGGER IF EXISTS trg_rbac_mirror_iam_policies_upd ON kortix.iam_policies;
DROP TRIGGER IF EXISTS trg_rbac_mirror_iam_policies_del ON kortix.iam_policies;
DROP TRIGGER IF EXISTS trg_rbac_mirror_resource_grants_ins ON kortix.iam_resource_grants;
DROP TRIGGER IF EXISTS trg_rbac_mirror_resource_grants_upd ON kortix.iam_resource_grants;
DROP TRIGGER IF EXISTS trg_rbac_mirror_resource_grants_del ON kortix.iam_resource_grants;

DROP FUNCTION IF EXISTS kortix.rbac_mirror_account_members();
DROP FUNCTION IF EXISTS kortix.rbac_mirror_project_members();
DROP FUNCTION IF EXISTS kortix.rbac_mirror_project_group_grants();
DROP FUNCTION IF EXISTS kortix.rbac_mirror_iam_policies();
DROP FUNCTION IF EXISTS kortix.rbac_mirror_resource_grants();
DROP FUNCTION IF EXISTS kortix.rbac_mirror_upsert(
  uuid, text, uuid, uuid, text, uuid, text, text, timestamptz, uuid, text);

-- Local-developer residue, not part of this system. `kortix.workspace_members`
-- and `kortix.workspace_group_grants` are created only by
-- 20260726040600000_workspace_domain.sql, which lives on the unmerged
-- refactor/projects-to-workspaces* branches and has no row in
-- kortix_migrations.pgmigrations on dev, staging or prod (verified). A
-- developer database that once ran that branch still carries them, and they
-- DEPEND on the two tables section 3 drops, so the drop would fail there with
-- "cannot drop ... because other objects depend on it". IF EXISTS keeps this a
-- no-op everywhere else.
DROP VIEW IF EXISTS kortix.workspace_members;
DROP VIEW IF EXISTS kortix.workspace_group_grants;

-- ─── 2. roles / role_permissions / group_members become physical ────────────

DROP VIEW kortix.roles;
DROP VIEW kortix.role_permissions;
DROP VIEW kortix.group_members;

-- Each rename is immediately followed by a view of the same name and the same
-- columns (below), so no client can observe it. That is why the four
-- renaming-table findings and the one renaming-column finding are suppressed
-- individually rather than waived for the file.
-- squawk-ignore renaming-table
ALTER TABLE kortix.iam_roles RENAME TO roles;
-- squawk-ignore renaming-column
ALTER TABLE kortix.roles RENAME COLUMN is_builtin TO is_system;
-- squawk-ignore renaming-table
ALTER TABLE kortix.iam_role_actions RENAME TO role_permissions;
-- squawk-ignore renaming-table
ALTER TABLE kortix.account_group_members RENAME TO group_members;

COMMENT ON TABLE kortix.roles IS
  'Every role. account_id IS NULL = a system role (owner/admin/member at account scope, manager/member/agent-user at project scope).';
COMMENT ON TABLE kortix.role_permissions IS
  'Role -> permission. FK to kortix.permissions.';
COMMENT ON TABLE kortix.group_members IS
  'Group membership. An identity fact, not a grant — grants live in kortix.role_assignments.';

-- The legacy names, as auto-updatable single-table views. Renamed simple column
-- references stay assignable, so INSERT/UPDATE/DELETE (and ON CONFLICT, with or
-- without a target) pass straight through for any code still using them.
CREATE VIEW kortix.iam_roles AS
  SELECT role_id, account_id, key, name, description, scope_type,
         is_system AS is_builtin, created_by, created_at, updated_at
    FROM kortix.roles;
COMMENT ON VIEW kortix.iam_roles IS
  'Compatibility name for kortix.roles. Write-through. Drops after the next release.';

CREATE VIEW kortix.iam_role_actions AS
  SELECT role_id, action FROM kortix.role_permissions;
COMMENT ON VIEW kortix.iam_role_actions IS
  'Compatibility name for kortix.role_permissions. Write-through. Drops after the next release.';

CREATE VIEW kortix.account_group_members AS
  SELECT group_id, user_id, added_by, added_at FROM kortix.group_members;
COMMENT ON VIEW kortix.account_group_members IS
  'Compatibility name for kortix.group_members. Write-through. Drops after the next release.';

-- ─── 3. Shared helpers for the compatibility write path ─────────────────────

-- normalizeProjectRole, in SQL. `project_role` still carries the undroppable
-- enum labels `editor`/`viewer`/`user`; they fold exactly as the TypeScript
-- parser folds them on read, and exactly as the backfill folded them.
CREATE OR REPLACE FUNCTION kortix.rbac_project_role_key(raw text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE raw
           WHEN 'editor' THEN 'manager'
           WHEN 'viewer' THEN 'member'
           WHEN 'user'   THEN 'member'
           ELSE raw
         END
$$;

-- The id of a system role. Re-pointed at kortix.roles now that it is the table.
CREATE OR REPLACE FUNCTION kortix.rbac_system_role_id(p_scope text, p_key text)
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT r.role_id
    FROM kortix.roles r
   WHERE r.account_id IS NULL
     AND r.scope_type = p_scope
     AND r.key = p_key
   LIMIT 1
$$;

-- ONE upsert, on the same expression index assignRole() conflicts against, and
-- with the same COALESCE on granted_by: a re-grant by a real writer records the
-- new granter, a system re-grant must not erase the one already there.
-- Returns the assignment id, because two compatibility views expose it as their
-- primary key (iam_policies.policy_id, iam_resource_grants.grant_id) and their
-- INSTEAD OF triggers have to hand it back through RETURNING.
CREATE OR REPLACE FUNCTION kortix.rbac_upsert_assignment(
  p_account_id uuid,
  p_principal_type text,
  p_principal_id uuid,
  p_role_id uuid,
  p_scope_type text,
  p_scope_id uuid,
  p_object_type text,
  p_object_id text,
  p_expires_at timestamptz,
  p_granted_by uuid,
  p_source text
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_role_id IS NULL THEN
    RAISE EXCEPTION 'kortix.rbac_upsert_assignment: no such role (the system role seed has not run on this database)'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO kortix.role_assignments
    (account_id, principal_type, principal_id, role_id, scope_type, scope_id,
     object_type, object_id, expires_at, granted_by, source)
  VALUES
    (p_account_id, p_principal_type, p_principal_id, p_role_id, p_scope_type,
     p_scope_id, p_object_type, p_object_id, p_expires_at, p_granted_by, p_source)
  ON CONFLICT (account_id, principal_type, principal_id, role_id, scope_type,
               coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(object_type, ''), coalesce(object_id, ''))
  DO UPDATE SET expires_at = excluded.expires_at,
                granted_by = coalesce(excluded.granted_by, kortix.role_assignments.granted_by),
                updated_at = now()
  RETURNING assignment_id INTO v_id;

  RETURN v_id;
END;
$$;

-- ─── 4. project_members becomes a view ──────────────────────────────────────
-- DISTINCT ON, not a plain filter. The legacy table's PRIMARY KEY was
-- (project_id, user_id) — at most one row per pair — while role_assignments
-- lets a `member` and a `manager` assignment for the same pair coexist (1 such
-- pair exists on the local dataset today). Rendering both would double-count
-- every member list built on this name. The strongest role wins, which is the
-- fold every reader applied anyway.

-- squawk-ignore ban-drop-table
DROP TABLE kortix.project_members;

CREATE VIEW kortix.project_members AS
  SELECT DISTINCT ON (ra.scope_id, ra.principal_id)
         ra.account_id,
         ra.scope_id                 AS project_id,
         ra.principal_id             AS user_id,
         r.key::kortix.project_role  AS project_role,
         ra.granted_by,
         ra.created_at,
         ra.updated_at,
         ra.expires_at
    FROM kortix.role_assignments ra
    JOIN kortix.roles r ON r.role_id = ra.role_id
   WHERE ra.principal_type = 'user'
     AND ra.scope_type = 'project'
     AND ra.object_type IS NULL
     AND r.account_id IS NULL
     AND r.scope_type = 'project'
     AND r.key IN ('manager','member')
   ORDER BY ra.scope_id, ra.principal_id,
            CASE r.key WHEN 'manager' THEN 2 ELSE 1 END DESC;

COMMENT ON VIEW kortix.project_members IS
  'Compatibility name. The rows live in kortix.role_assignments; writes here are rewritten by INSTEAD OF triggers.';

CREATE OR REPLACE FUNCTION kortix.rbac_compat_project_members()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role_id uuid;
  v_user uuid;
  v_project uuid;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM kortix.role_assignments ra
     USING kortix.roles r
     WHERE ra.role_id = r.role_id
       AND r.account_id IS NULL
       AND r.scope_type = 'project'
       AND r.key IN ('manager','member')
       AND ra.principal_type = 'user'
       AND ra.principal_id = OLD.user_id
       AND ra.scope_type = 'project'
       AND ra.scope_id = OLD.project_id
       AND ra.object_type IS NULL;
    RETURN OLD;
  END IF;

  v_user    := NEW.user_id;
  v_project := NEW.project_id;
  v_role_id := kortix.rbac_system_role_id(
    'project', kortix.rbac_project_role_key(NEW.project_role::text));

  -- A role CHANGE must retract the old one, or manager->member would leave the
  -- manager assignment live and the demotion would be a no-op for the engine.
  DELETE FROM kortix.role_assignments ra
   USING kortix.roles r
   WHERE ra.role_id = r.role_id
     AND r.account_id IS NULL
     AND r.scope_type = 'project'
     AND r.key IN ('manager','member')
     AND ra.principal_type = 'user'
     AND ra.principal_id = v_user
     AND ra.scope_type = 'project'
     AND ra.scope_id = v_project
     AND ra.object_type IS NULL
     AND ra.role_id IS DISTINCT FROM v_role_id;

  PERFORM kortix.rbac_upsert_assignment(
    NEW.account_id, 'user', v_user, v_role_id, 'project', v_project,
    NULL, NULL, NEW.expires_at, NEW.granted_by, 'manual');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_rbac_compat_project_members_ins
  INSTEAD OF INSERT ON kortix.project_members
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_compat_project_members();
CREATE TRIGGER trg_rbac_compat_project_members_upd
  INSTEAD OF UPDATE ON kortix.project_members
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_compat_project_members();
CREATE TRIGGER trg_rbac_compat_project_members_del
  INSTEAD OF DELETE ON kortix.project_members
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_compat_project_members();

-- ─── 5. project_group_grants becomes a view ─────────────────────────────────

-- squawk-ignore ban-drop-table
DROP TABLE kortix.project_group_grants;

CREATE VIEW kortix.project_group_grants AS
  SELECT DISTINCT ON (ra.scope_id, ra.principal_id)
         ra.scope_id                 AS project_id,
         ra.principal_id             AS group_id,
         ra.account_id,
         r.key::kortix.project_role  AS role,
         ra.granted_by,
         ra.created_at,
         ra.updated_at,
         ra.expires_at
    FROM kortix.role_assignments ra
    JOIN kortix.roles r ON r.role_id = ra.role_id
   WHERE ra.principal_type = 'group'
     AND ra.scope_type = 'project'
     AND ra.object_type IS NULL
     AND r.account_id IS NULL
     AND r.scope_type = 'project'
     AND r.key IN ('manager','member')
   ORDER BY ra.scope_id, ra.principal_id,
            CASE r.key WHEN 'manager' THEN 2 ELSE 1 END DESC;

COMMENT ON VIEW kortix.project_group_grants IS
  'Compatibility name. The rows live in kortix.role_assignments; writes here are rewritten by INSTEAD OF triggers.';

CREATE OR REPLACE FUNCTION kortix.rbac_compat_project_group_grants()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role_id uuid;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM kortix.role_assignments ra
     USING kortix.roles r
     WHERE ra.role_id = r.role_id
       AND r.account_id IS NULL
       AND r.scope_type = 'project'
       AND r.key IN ('manager','member')
       AND ra.principal_type = 'group'
       AND ra.principal_id = OLD.group_id
       AND ra.scope_type = 'project'
       AND ra.scope_id = OLD.project_id
       AND ra.object_type IS NULL;
    RETURN OLD;
  END IF;

  v_role_id := kortix.rbac_system_role_id(
    'project', kortix.rbac_project_role_key(NEW.role::text));

  DELETE FROM kortix.role_assignments ra
   USING kortix.roles r
   WHERE ra.role_id = r.role_id
     AND r.account_id IS NULL
     AND r.scope_type = 'project'
     AND r.key IN ('manager','member')
     AND ra.principal_type = 'group'
     AND ra.principal_id = NEW.group_id
     AND ra.scope_type = 'project'
     AND ra.scope_id = NEW.project_id
     AND ra.object_type IS NULL
     AND ra.role_id IS DISTINCT FROM v_role_id;

  PERFORM kortix.rbac_upsert_assignment(
    NEW.account_id, 'group', NEW.group_id, v_role_id, 'project', NEW.project_id,
    NULL, NULL, NEW.expires_at, NEW.granted_by, 'manual');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_rbac_compat_group_grants_ins
  INSTEAD OF INSERT ON kortix.project_group_grants
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_compat_project_group_grants();
CREATE TRIGGER trg_rbac_compat_group_grants_upd
  INSTEAD OF UPDATE ON kortix.project_group_grants
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_compat_project_group_grants();
CREATE TRIGGER trg_rbac_compat_group_grants_del
  INSTEAD OF DELETE ON kortix.project_group_grants
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_compat_project_group_grants();

-- ─── 6. iam_policies becomes a view ─────────────────────────────────────────
-- `policy_id` IS the assignment id, which is what makes the compatibility
-- UPDATE and DELETE paths exact: they address one canonical row by primary key.
-- Custom roles only (account_id IS NOT NULL on the role), as before — a system
-- role binding was never an iam_policies row.

-- squawk-ignore ban-drop-table
DROP TABLE kortix.iam_policies;

CREATE VIEW kortix.iam_policies AS
  SELECT ra.assignment_id AS policy_id,
         ra.account_id,
         (CASE ra.principal_type
            WHEN 'user'            THEN 'member'
            WHEN 'group'           THEN 'group'
            WHEN 'service_account' THEN 'token'
          END)::varchar(16) AS principal_type,
         ra.principal_id,
         ra.role_id,
         ra.scope_type::varchar(16) AS scope_type,
         ra.scope_id,
         ra.expires_at,
         ra.granted_by,
         ra.created_at,
         ra.updated_at
    FROM kortix.role_assignments ra
    JOIN kortix.roles r ON r.role_id = ra.role_id
   WHERE ra.object_type IS NULL
     AND r.account_id IS NOT NULL
     AND ra.principal_type IN ('user','group','service_account');

COMMENT ON VIEW kortix.iam_policies IS
  'Compatibility name. policy_id IS the assignment id. Writes here are rewritten by INSTEAD OF triggers.';

CREATE OR REPLACE FUNCTION kortix.rbac_compat_iam_policies()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_principal text;
  v_id uuid;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM kortix.role_assignments WHERE assignment_id = OLD.policy_id;
    RETURN OLD;
  END IF;

  v_principal := CASE NEW.principal_type
                   WHEN 'member' THEN 'user'
                   WHEN 'group'  THEN 'group'
                   WHEN 'token'  THEN 'service_account'
                 END;
  IF v_principal IS NULL THEN
    RAISE EXCEPTION 'kortix.iam_policies: unknown principal_type %', NEW.principal_type
      USING ERRCODE = 'check_violation';
  END IF;

  IF (TG_OP = 'UPDATE') THEN
    UPDATE kortix.role_assignments
       SET account_id     = NEW.account_id,
           principal_type = v_principal,
           principal_id   = NEW.principal_id,
           role_id        = NEW.role_id,
           scope_type     = NEW.scope_type,
           scope_id       = NEW.scope_id,
           expires_at     = NEW.expires_at,
           granted_by     = coalesce(NEW.granted_by, granted_by),
           updated_at     = now()
     WHERE assignment_id = OLD.policy_id;
    RETURN NEW;
  END IF;

  v_id := kortix.rbac_upsert_assignment(
    NEW.account_id, v_principal, NEW.principal_id, NEW.role_id, NEW.scope_type,
    NEW.scope_id, NULL, NULL, NEW.expires_at, NEW.granted_by, 'manual');
  NEW.policy_id := v_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_rbac_compat_iam_policies_ins
  INSTEAD OF INSERT ON kortix.iam_policies
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_compat_iam_policies();
CREATE TRIGGER trg_rbac_compat_iam_policies_upd
  INSTEAD OF UPDATE ON kortix.iam_policies
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_compat_iam_policies();
CREATE TRIGGER trg_rbac_compat_iam_policies_del
  INSTEAD OF DELETE ON kortix.iam_policies
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_compat_iam_policies();

-- ─── 7. iam_resource_grants becomes a view ──────────────────────────────────
-- `effect` renders as the constant 'allow'. 'deny' was reserved and never
-- written, and every read filtered effect='allow', so there is no row to lose —
-- but a write that asks for a different effect is REJECTED rather than silently
-- stored as an allow.

-- squawk-ignore ban-drop-table
DROP TABLE kortix.iam_resource_grants;

CREATE VIEW kortix.iam_resource_grants AS
  SELECT ra.assignment_id            AS grant_id,
         ra.account_id,
         ra.scope_id                 AS project_id,
         ra.object_type::varchar(32) AS resource_type,
         ra.object_id                AS resource_id,
         (CASE ra.principal_type WHEN 'user' THEN 'member' ELSE 'group' END)::varchar(16)
           AS principal_type,
         ra.principal_id,
         'allow'::varchar(8)         AS effect,
         ra.expires_at,
         ra.granted_by,
         ra.created_at,
         ra.updated_at
    FROM kortix.role_assignments ra
   WHERE ra.object_type IS NOT NULL
     AND ra.principal_type IN ('user','group');

COMMENT ON VIEW kortix.iam_resource_grants IS
  'Compatibility name. grant_id IS the assignment id. Writes here are rewritten by INSTEAD OF triggers.';

CREATE OR REPLACE FUNCTION kortix.rbac_compat_resource_grants()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role_id uuid;
  v_principal text;
  v_id uuid;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM kortix.role_assignments WHERE assignment_id = OLD.grant_id;
    RETURN OLD;
  END IF;

  IF NEW.effect IS DISTINCT FROM 'allow' THEN
    RAISE EXCEPTION 'kortix.iam_resource_grants: effect % is not supported — an object assignment is always an allow', NEW.effect
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.principal_type NOT IN ('member','group') THEN
    RAISE EXCEPTION 'kortix.iam_resource_grants: unknown principal_type %', NEW.principal_type
      USING ERRCODE = 'check_violation';
  END IF;

  v_principal := CASE NEW.principal_type WHEN 'member' THEN 'user' ELSE 'group' END;

  IF (TG_OP = 'UPDATE') THEN
    UPDATE kortix.role_assignments
       SET account_id     = NEW.account_id,
           principal_type = v_principal,
           principal_id   = NEW.principal_id,
           scope_id       = NEW.project_id,
           object_type    = NEW.resource_type,
           object_id      = NEW.resource_id,
           expires_at     = NEW.expires_at,
           granted_by     = coalesce(NEW.granted_by, granted_by),
           updated_at     = now()
     WHERE assignment_id = OLD.grant_id;
    RETURN NEW;
  END IF;

  v_role_id := kortix.rbac_system_role_id('project', 'agent-user');
  v_id := kortix.rbac_upsert_assignment(
    NEW.account_id, v_principal, NEW.principal_id, v_role_id, 'project',
    NEW.project_id, NEW.resource_type, NEW.resource_id, NEW.expires_at,
    NEW.granted_by, 'manual');
  NEW.grant_id := v_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_rbac_compat_resource_grants_ins
  INSTEAD OF INSERT ON kortix.iam_resource_grants
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_compat_resource_grants();
CREATE TRIGGER trg_rbac_compat_resource_grants_upd
  INSTEAD OF UPDATE ON kortix.iam_resource_grants
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_compat_resource_grants();
CREATE TRIGGER trg_rbac_compat_resource_grants_del
  INSTEAD OF DELETE ON kortix.iam_resource_grants
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_compat_resource_grants();

-- ─── 8. account_members keeps identity, loses the role column ───────────────
-- The table survives under a new name carrying ONLY identity: user_id,
-- account_id, is_super_admin, scim_external_id, joined_at. `is_super_admin`
-- stays a column by decision (spec §1) — it is a hard, audited bypass, not a
-- role, and 22,408 of 33,363 local rows carry it.
--
-- `account_members` immediately reappears as a view with the SAME columns in the
-- SAME order, account_role derived from the strongest live account-scope system
-- role, so `SELECT account_role FROM account_members` keeps working for
-- accounts/core/members.ts, accounts/iam/mfa.ts, projects/routes/group-grants.ts,
-- projects/routes/r6.ts and every other direct reader.

-- One RLS policy reads the column and therefore blocks the DROP:
-- `credit_accounts_owner_manage` lets an account OWNER manage their own
-- credit_accounts row. It is re-created below against kortix.role_assignments,
-- which is where "is an owner" now lives. The other four credit_* policies
-- (credit_accounts_member_select, credit_ledger_member_select,
-- credit_purchases_member_select, credit_usage_member_select) reference only
-- user_id/account_id — pure membership identity — so the rename carries them to
-- kortix.account_memberships unchanged and they keep meaning exactly what they
-- meant. Verified by scanning pg_policies for every expression naming any of the
-- legacy stores: those five are the complete set.
DROP POLICY IF EXISTS credit_accounts_owner_manage ON kortix.credit_accounts;

-- squawk-ignore renaming-table
ALTER TABLE kortix.account_members RENAME TO account_memberships;
-- squawk-ignore ban-drop-column
ALTER TABLE kortix.account_memberships DROP COLUMN account_role;

COMMENT ON TABLE kortix.account_memberships IS
  'Identity half of account membership. The ROLE lives in kortix.role_assignments.';

CREATE VIEW kortix.account_members AS
  SELECT m.user_id,
         m.account_id,
         COALESCE(
           (SELECT r.key::kortix.account_role
              FROM kortix.role_assignments ra
              JOIN kortix.roles r ON r.role_id = ra.role_id
             WHERE ra.account_id = m.account_id
               AND ra.principal_type = 'user'
               AND ra.principal_id = m.user_id
               AND ra.scope_type = 'account'
               AND ra.object_type IS NULL
               AND r.account_id IS NULL
               AND r.scope_type = 'account'
               AND (ra.expires_at IS NULL OR ra.expires_at > now())
             ORDER BY CASE r.key WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 ELSE 1 END DESC
             LIMIT 1),
           'member'::kortix.account_role
         ) AS account_role,
         m.joined_at,
         m.is_super_admin,
         m.scim_external_id
    FROM kortix.account_memberships m;

COMMENT ON VIEW kortix.account_members IS
  'Compatibility name. Identity comes from kortix.account_memberships, account_role from kortix.role_assignments. Writes here are rewritten by INSTEAD OF triggers.';

-- Re-created against the canonical store. Same rule, same wording of the rule:
-- "the authenticated caller holds the system `owner` role on this account".
-- Reading role_assignments directly rather than the compatibility view keeps the
-- policy off a view whose INSTEAD OF triggers exist for writes it never makes.
CREATE POLICY credit_accounts_owner_manage ON kortix.credit_accounts
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1
      FROM kortix.role_assignments ra
      JOIN kortix.roles r ON r.role_id = ra.role_id
     WHERE ra.account_id = credit_accounts.account_id
       AND ra.principal_type = 'user'
       AND ra.principal_id = (SELECT auth.uid())
       AND ra.scope_type = 'account'
       AND ra.object_type IS NULL
       AND r.account_id IS NULL
       AND r.scope_type = 'account'
       AND r.key = 'owner'
       AND (ra.expires_at IS NULL OR ra.expires_at > now())));

CREATE OR REPLACE FUNCTION kortix.rbac_compat_account_members()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role_id uuid;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    -- Membership is gone: every SYSTEM account-scope role this user held in this
    -- account goes with it. Custom-role assignments (account_id IS NOT NULL on
    -- the role) are owned by the iam_policies surface and are left alone, which
    -- is exactly what the dual-write mirror did.
    DELETE FROM kortix.role_assignments ra
     USING kortix.roles r
     WHERE ra.role_id = r.role_id
       AND r.account_id IS NULL
       AND r.scope_type = 'account'
       AND ra.account_id = OLD.account_id
       AND ra.principal_type = 'user'
       AND ra.principal_id = OLD.user_id
       AND ra.scope_type = 'account';
    DELETE FROM kortix.account_memberships
     WHERE account_id = OLD.account_id AND user_id = OLD.user_id;
    RETURN OLD;
  END IF;

  IF (TG_OP = 'INSERT') THEN
    INSERT INTO kortix.account_memberships
      (user_id, account_id, joined_at, is_super_admin, scim_external_id)
    VALUES
      (NEW.user_id, NEW.account_id, COALESCE(NEW.joined_at, now()),
       COALESCE(NEW.is_super_admin, false), NEW.scim_external_id)
    ON CONFLICT (user_id, account_id) DO UPDATE
      SET is_super_admin   = excluded.is_super_admin,
          scim_external_id = excluded.scim_external_id;
  ELSE
    UPDATE kortix.account_memberships
       SET is_super_admin   = NEW.is_super_admin,
           scim_external_id = NEW.scim_external_id,
           joined_at        = NEW.joined_at
     WHERE account_id = OLD.account_id AND user_id = OLD.user_id;
  END IF;

  -- The role half. A role CHANGE must retract the old one, or owner->member
  -- would leave the owner assignment live and the demotion would be a no-op.
  v_role_id := kortix.rbac_system_role_id('account', NEW.account_role::text);
  DELETE FROM kortix.role_assignments ra
   USING kortix.roles r
   WHERE ra.role_id = r.role_id
     AND r.account_id IS NULL
     AND r.scope_type = 'account'
     AND ra.account_id = NEW.account_id
     AND ra.principal_type = 'user'
     AND ra.principal_id = NEW.user_id
     AND ra.scope_type = 'account'
     AND ra.role_id IS DISTINCT FROM v_role_id;

  PERFORM kortix.rbac_upsert_assignment(
    NEW.account_id, 'user', NEW.user_id, v_role_id, 'account', NULL, NULL, NULL,
    NULL, NULL,
    CASE WHEN NEW.scim_external_id IS NOT NULL THEN 'scim' ELSE 'system' END);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_rbac_compat_account_members_ins
  INSTEAD OF INSERT ON kortix.account_members
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_compat_account_members();
CREATE TRIGGER trg_rbac_compat_account_members_upd
  INSTEAD OF UPDATE ON kortix.account_members
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_compat_account_members();
CREATE TRIGGER trg_rbac_compat_account_members_del
  INSTEAD OF DELETE ON kortix.account_members
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_compat_account_members();

-- ─── 9. Drop the dead tiers (spec §3.4) ─────────────────────────────────────
-- 0 rows in every environment; the only code that named them is the drizzle
-- schema declaration this PR also deletes. kortix.sandbox_members is NOT here —
-- see the mixed-version note at the top of this file.

-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS kortix.sandbox_member_scopes;
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS kortix.sandbox_invites;
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS kortix.connector_grants;
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS kortix.session_folder_grants;

-- `kortix.scope_effect` ('grant' | 'revoke') existed for exactly one column:
-- sandbox_member_scopes.effect, dropped above. Verified 0 remaining columns of
-- this type before the drop. `iam_resource_grants.effect` was a varchar, not
-- this enum, and went with its table.
DROP TYPE IF EXISTS kortix.scope_effect;

-- ─── 10. A project delete must still retract its grants ─────────────────────
-- project_members, project_group_grants and iam_resource_grants all had
-- `ON DELETE CASCADE` from kortix.projects. Now that they are views, the cascade
-- has to live on the store — otherwise deleting a project would strand every
-- grant that named it, and the cutover would be a regression.
--
-- NOT VALID: 627 such orphans already exist on the local dataset (assignments
-- whose project was deleted through a path that never cascaded), so a validating
-- ADD would fail. 20260819160000000_rbac_cutover_backfill.concurrent.ts purges
-- them in bounded batches immediately before this file, and
-- 20260819160200000_rbac_validate_assignment_scope_fk.sql validates the
-- constraint straight after — expand/contract, per MIGRATIONS.md.
ALTER TABLE kortix.role_assignments
  ADD CONSTRAINT role_assignments_scope_id_projects_project_id_fk
  FOREIGN KEY (scope_id) REFERENCES kortix.projects(project_id)
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

-- ─── 11. Validate the catalog FK deferred by PR 2 ───────────────────────────
-- 20260819015724479 added it NOT VALID so the ADD took no scan. Every
-- role_permissions row is a catalog action (asserted by
-- integration-iam-role-catalog-parity), so this scan finds nothing to reject.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE, which does not block reads or writes.

ALTER TABLE kortix.role_permissions
  VALIDATE CONSTRAINT role_permissions_action_permissions_fk;
