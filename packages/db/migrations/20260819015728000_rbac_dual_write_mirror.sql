-- Migration: rbac_dual_write_mirror
--
-- THE DUAL-WRITE HALF OF THE DUAL-READ WINDOW.
--
-- 20260819015725000 backfilled `kortix.role_assignments` from the five legacy
-- grant stores, and the engine now reads ONLY role_assignments. That leaves a
-- gap the backfill cannot close: anything that writes a legacy table AFTER the
-- backfill ran is invisible to the engine. Three writers do exactly that during
-- the window:
--
--   1. A replica still running the pre-cutover image. A rolling deploy has both
--      versions live for minutes; the old one writes `project_members` and
--      nothing else, and the grant it just made would not exist for the new one.
--   2. `pg_restore` / a support script / a manual SQL fix on the legacy table.
--   3. Test fixtures that seed membership with a direct INSERT.
--
-- Rewiring the 129 application write sites to `assignRole()` (which this PR also
-- does) fixes (1) only for the NEW image and does nothing for (2) or (3). A
-- trigger fixes all three, is inside the writer's own transaction by
-- construction, and cannot be forgotten by a future call site.
--
-- DIRECTION IS ONE-WAY: legacy -> canonical. `role_assignments` is never mirrored
-- back, because it is the store that is meant to win. A row written only through
-- `assignRole()` therefore leaves `account_members.account_role` stale — which is
-- correct and deliberate: no engine reads that column any more.
--
-- The `UPDATE OF <cols>` clauses matter. Without them, an UPDATE that touches an
-- unrelated column (e.g. `account_members.is_super_admin`) would re-derive the
-- assignment from the legacy column and could DELETE an assignment that
-- `assignRole()` had written but the legacy column does not know about. Firing
-- only when a mirrored column is in the SET list makes the trigger own exactly
-- the rows it created.
--
-- Removed at the cutover, when the legacy tables become views over
-- `role_assignments` (migrations-pending/…_rbac_dual_read_views.sql) and there
-- is no second physical store left to mirror.
--
-- mixed-version-safe: adds triggers only. An old replica's writes now ALSO land
-- in role_assignments (that is the point); a new replica's writes are unchanged
-- because every mirrored INSERT is an idempotent upsert on the same identity
-- index `assignRole()` targets.
--
-- backfill-safe: creates functions and triggers. No data pass, no table scan,
-- no row lock beyond the catalog updates.

set lock_timeout = '2s';
set statement_timeout = '60s';

-- ─── Shared helpers ─────────────────────────────────────────────────────────

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

-- The id of a built-in (account_id IS NULL) role.
CREATE OR REPLACE FUNCTION kortix.rbac_system_role_id(p_scope text, p_key text)
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT r.role_id
    FROM kortix.iam_roles r
   WHERE r.account_id IS NULL
     AND r.scope_type = p_scope
     AND r.key = p_key
   LIMIT 1
$$;

-- One upsert, on the same expression index `assignRole()` conflicts against.
CREATE OR REPLACE FUNCTION kortix.rbac_mirror_upsert(
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
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- A role that does not exist means the seed has not run on this database.
  -- Skip rather than fail the caller's write: refusing an ordinary membership
  -- INSERT because a catalog row is missing would take the API down.
  IF p_role_id IS NULL THEN
    RETURN;
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
                updated_at = now();
END;
$$;

-- ─── 1. account_members.account_role -> (user, <role>, account) ─────────────

CREATE OR REPLACE FUNCTION kortix.rbac_mirror_account_members()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role_id uuid;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    -- Membership is gone: every SYSTEM account-scope role this user held in this
    -- account goes with it. Custom-role assignments (account_id IS NOT NULL on
    -- the role) are owned by iam_policies and are left alone.
    DELETE FROM kortix.role_assignments ra
     USING kortix.iam_roles r
     WHERE ra.role_id = r.role_id
       AND r.account_id IS NULL
       AND r.scope_type = 'account'
       AND ra.account_id = OLD.account_id
       AND ra.principal_type = 'user'
       AND ra.principal_id = OLD.user_id
       AND ra.scope_type = 'account';
    RETURN OLD;
  END IF;

  v_role_id := kortix.rbac_system_role_id('account', NEW.account_role::text);

  -- A role CHANGE must retract the old one, or owner->member would leave the
  -- owner assignment live and the demotion would be a no-op for the engine.
  DELETE FROM kortix.role_assignments ra
   USING kortix.iam_roles r
   WHERE ra.role_id = r.role_id
     AND r.account_id IS NULL
     AND r.scope_type = 'account'
     AND ra.account_id = NEW.account_id
     AND ra.principal_type = 'user'
     AND ra.principal_id = NEW.user_id
     AND ra.scope_type = 'account'
     AND ra.role_id IS DISTINCT FROM v_role_id;

  PERFORM kortix.rbac_mirror_upsert(
    NEW.account_id, 'user', NEW.user_id, v_role_id, 'account', NULL, NULL, NULL,
    NULL, NULL,
    CASE WHEN NEW.scim_external_id IS NOT NULL THEN 'scim' ELSE 'system' END);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rbac_mirror_account_members_ins ON kortix.account_members;
CREATE TRIGGER trg_rbac_mirror_account_members_ins
  AFTER INSERT ON kortix.account_members
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_mirror_account_members();

DROP TRIGGER IF EXISTS trg_rbac_mirror_account_members_upd ON kortix.account_members;
CREATE TRIGGER trg_rbac_mirror_account_members_upd
  AFTER UPDATE OF account_role, scim_external_id ON kortix.account_members
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_mirror_account_members();

DROP TRIGGER IF EXISTS trg_rbac_mirror_account_members_del ON kortix.account_members;
CREATE TRIGGER trg_rbac_mirror_account_members_del
  AFTER DELETE ON kortix.account_members
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_mirror_account_members();

-- ─── 2. project_members.project_role -> (user, <role>, project) ─────────────

CREATE OR REPLACE FUNCTION kortix.rbac_mirror_project_members()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role_id uuid;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM kortix.role_assignments ra
     USING kortix.iam_roles r
     WHERE ra.role_id = r.role_id
       AND r.account_id IS NULL
       AND r.scope_type = 'project'
       AND r.key <> 'agent-user'
       AND ra.principal_type = 'user'
       AND ra.principal_id = OLD.user_id
       AND ra.scope_type = 'project'
       AND ra.scope_id = OLD.project_id
       AND ra.object_type IS NULL;
    RETURN OLD;
  END IF;

  v_role_id := kortix.rbac_system_role_id(
    'project', kortix.rbac_project_role_key(NEW.project_role::text));

  DELETE FROM kortix.role_assignments ra
   USING kortix.iam_roles r
   WHERE ra.role_id = r.role_id
     AND r.account_id IS NULL
     AND r.scope_type = 'project'
     AND r.key <> 'agent-user'
     AND ra.principal_type = 'user'
     AND ra.principal_id = NEW.user_id
     AND ra.scope_type = 'project'
     AND ra.scope_id = NEW.project_id
     AND ra.object_type IS NULL
     AND ra.role_id IS DISTINCT FROM v_role_id;

  PERFORM kortix.rbac_mirror_upsert(
    NEW.account_id, 'user', NEW.user_id, v_role_id, 'project', NEW.project_id,
    NULL, NULL, NEW.expires_at, NEW.granted_by, 'manual');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rbac_mirror_project_members_ins ON kortix.project_members;
CREATE TRIGGER trg_rbac_mirror_project_members_ins
  AFTER INSERT ON kortix.project_members
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_mirror_project_members();

DROP TRIGGER IF EXISTS trg_rbac_mirror_project_members_upd ON kortix.project_members;
CREATE TRIGGER trg_rbac_mirror_project_members_upd
  AFTER UPDATE OF project_role, expires_at, granted_by ON kortix.project_members
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_mirror_project_members();

DROP TRIGGER IF EXISTS trg_rbac_mirror_project_members_del ON kortix.project_members;
CREATE TRIGGER trg_rbac_mirror_project_members_del
  AFTER DELETE ON kortix.project_members
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_mirror_project_members();

-- ─── 3. project_group_grants.role -> (group, <role>, project) ──────────────

CREATE OR REPLACE FUNCTION kortix.rbac_mirror_project_group_grants()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role_id uuid;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM kortix.role_assignments ra
     USING kortix.iam_roles r
     WHERE ra.role_id = r.role_id
       AND r.account_id IS NULL
       AND r.scope_type = 'project'
       AND r.key <> 'agent-user'
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
   USING kortix.iam_roles r
   WHERE ra.role_id = r.role_id
     AND r.account_id IS NULL
     AND r.scope_type = 'project'
     AND r.key <> 'agent-user'
     AND ra.principal_type = 'group'
     AND ra.principal_id = NEW.group_id
     AND ra.scope_type = 'project'
     AND ra.scope_id = NEW.project_id
     AND ra.object_type IS NULL
     AND ra.role_id IS DISTINCT FROM v_role_id;

  PERFORM kortix.rbac_mirror_upsert(
    NEW.account_id, 'group', NEW.group_id, v_role_id, 'project', NEW.project_id,
    NULL, NULL, NEW.expires_at, NEW.granted_by, 'manual');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rbac_mirror_group_grants_ins ON kortix.project_group_grants;
CREATE TRIGGER trg_rbac_mirror_group_grants_ins
  AFTER INSERT ON kortix.project_group_grants
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_mirror_project_group_grants();

DROP TRIGGER IF EXISTS trg_rbac_mirror_group_grants_upd ON kortix.project_group_grants;
CREATE TRIGGER trg_rbac_mirror_group_grants_upd
  AFTER UPDATE OF role, expires_at, granted_by ON kortix.project_group_grants
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_mirror_project_group_grants();

DROP TRIGGER IF EXISTS trg_rbac_mirror_group_grants_del ON kortix.project_group_grants;
CREATE TRIGGER trg_rbac_mirror_group_grants_del
  AFTER DELETE ON kortix.project_group_grants
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_mirror_project_group_grants();

-- ─── 4. iam_policies -> (principal, <custom role>, scope) ──────────────────
-- principal_type is renamed onto the canonical vocabulary: legacy 'member' meant
-- an auth user and 'token' meant a service account.

CREATE OR REPLACE FUNCTION kortix.rbac_mirror_iam_policies()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_principal text;
  v_old_principal text;
BEGIN
  IF (TG_OP <> 'INSERT') THEN
    v_old_principal := CASE OLD.principal_type
                         WHEN 'member' THEN 'user'
                         WHEN 'group'  THEN 'group'
                         WHEN 'token'  THEN 'service_account'
                       END;
    IF v_old_principal IS NOT NULL THEN
      DELETE FROM kortix.role_assignments ra
       WHERE ra.account_id = OLD.account_id
         AND ra.principal_type = v_old_principal
         AND ra.principal_id = OLD.principal_id
         AND ra.role_id = OLD.role_id
         AND ra.scope_type = OLD.scope_type
         AND ra.scope_id IS NOT DISTINCT FROM OLD.scope_id
         AND ra.object_type IS NULL;
    END IF;
    IF (TG_OP = 'DELETE') THEN
      RETURN OLD;
    END IF;
  END IF;

  v_principal := CASE NEW.principal_type
                   WHEN 'member' THEN 'user'
                   WHEN 'group'  THEN 'group'
                   WHEN 'token'  THEN 'service_account'
                 END;
  -- Same guards the backfill applied: an unknown principal type, an unknown
  -- scope, or a scope whose id disagrees with its type is not mirrored rather
  -- than silently coerced.
  IF v_principal IS NULL
     OR NEW.scope_type NOT IN ('account', 'project')
     OR ((NEW.scope_type = 'account') <> (NEW.scope_id IS NULL)) THEN
    RETURN NEW;
  END IF;

  PERFORM kortix.rbac_mirror_upsert(
    NEW.account_id, v_principal, NEW.principal_id, NEW.role_id, NEW.scope_type,
    NEW.scope_id, NULL, NULL, NEW.expires_at, NEW.granted_by, 'manual');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rbac_mirror_iam_policies_ins ON kortix.iam_policies;
CREATE TRIGGER trg_rbac_mirror_iam_policies_ins
  AFTER INSERT ON kortix.iam_policies
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_mirror_iam_policies();

DROP TRIGGER IF EXISTS trg_rbac_mirror_iam_policies_upd ON kortix.iam_policies;
CREATE TRIGGER trg_rbac_mirror_iam_policies_upd
  AFTER UPDATE OF principal_type, principal_id, role_id, scope_type, scope_id, expires_at
  ON kortix.iam_policies
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_mirror_iam_policies();

DROP TRIGGER IF EXISTS trg_rbac_mirror_iam_policies_del ON kortix.iam_policies;
CREATE TRIGGER trg_rbac_mirror_iam_policies_del
  AFTER DELETE ON kortix.iam_policies
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_mirror_iam_policies();

-- ─── 5. iam_resource_grants -> object assignment (role `agent-user`) ───────
-- `effect` is not carried: 'deny' was reserved and never written, and every read
-- filtered effect='allow'. A row with any other effect is skipped, never
-- promoted.

CREATE OR REPLACE FUNCTION kortix.rbac_mirror_resource_grants()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role_id uuid;
  v_principal text;
BEGIN
  v_role_id := kortix.rbac_system_role_id('project', 'agent-user');

  IF (TG_OP <> 'INSERT') THEN
    DELETE FROM kortix.role_assignments ra
     WHERE ra.account_id = OLD.account_id
       AND ra.principal_type = CASE OLD.principal_type WHEN 'member' THEN 'user' ELSE 'group' END
       AND ra.principal_id = OLD.principal_id
       AND ra.role_id = v_role_id
       AND ra.scope_type = 'project'
       AND ra.scope_id = OLD.project_id
       AND ra.object_type = OLD.resource_type
       AND ra.object_id = OLD.resource_id;
    IF (TG_OP = 'DELETE') THEN
      RETURN OLD;
    END IF;
  END IF;

  IF NEW.effect <> 'allow'
     OR NEW.principal_type NOT IN ('member', 'group')
     OR NEW.resource_type NOT IN ('agent', 'skill', 'secret', 'app', 'trigger') THEN
    RETURN NEW;
  END IF;

  v_principal := CASE NEW.principal_type WHEN 'member' THEN 'user' ELSE 'group' END;
  PERFORM kortix.rbac_mirror_upsert(
    NEW.account_id, v_principal, NEW.principal_id, v_role_id, 'project',
    NEW.project_id, NEW.resource_type, NEW.resource_id, NEW.expires_at,
    NEW.granted_by, 'manual');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rbac_mirror_resource_grants_ins ON kortix.iam_resource_grants;
CREATE TRIGGER trg_rbac_mirror_resource_grants_ins
  AFTER INSERT ON kortix.iam_resource_grants
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_mirror_resource_grants();

DROP TRIGGER IF EXISTS trg_rbac_mirror_resource_grants_upd ON kortix.iam_resource_grants;
CREATE TRIGGER trg_rbac_mirror_resource_grants_upd
  AFTER UPDATE OF principal_type, principal_id, resource_type, resource_id, effect, expires_at
  ON kortix.iam_resource_grants
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_mirror_resource_grants();

DROP TRIGGER IF EXISTS trg_rbac_mirror_resource_grants_del ON kortix.iam_resource_grants;
CREATE TRIGGER trg_rbac_mirror_resource_grants_del
  AFTER DELETE ON kortix.iam_resource_grants
  FOR EACH ROW EXECUTE FUNCTION kortix.rbac_mirror_resource_grants();
