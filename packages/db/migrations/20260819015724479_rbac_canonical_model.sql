-- Migration: rbac_canonical_model
--
-- Canonical RBAC (NIST RBAC1 + object scoping), PR 2 / P1 — the DATA MODEL.
-- Additive only: no live table is renamed, no column is dropped, every legacy
-- store keeps its rows and its writers. This migration creates the canonical
-- tables, seeds the catalog and the system roles, and publishes the canonical
-- NAMES as write-through views over the legacy tables.
--
-- WHAT LANDS
--   kortix.permissions        the action catalog (was apps/api/src/iam/actions.ts
--                             + role-perms.ts + NON_DELEGABLE_ACTIONS, three code
--                             constants with no FK). 69 rows.
--   kortix.object_policies    what "no grant exists for this object" means, per
--                             OBJECT TYPE (was the managerTier argument of
--                             isProjectResourceUsableByMember). 5 rows.
--   kortix.role_assignments   ONE table replacing account_members.account_role,
--                             project_members.project_role, project_group_grants,
--                             iam_policies, iam_resource_grants and an invite's
--                             bootstrap_grants. Empty here; the batched
--                             .concurrent.ts pass right after this one fills it.
--   kortix.iam_roles          account_id becomes NULLable so the 6 SYSTEM roles
--                             (owner/admin/member, manager/member, agent-user)
--                             live as rows. is_builtin now carries `is_system`.
--   kortix.roles              \
--   kortix.role_permissions    > canonical NAMES, as auto-updatable views over
--   kortix.group_members      /  iam_roles / iam_role_actions /
--                                account_group_members. Verified write-through
--                                (INSERT, INSERT..ON CONFLICT with and without a
--                                target, UPDATE, DELETE all work on a simple
--                                single-table view).
--
-- WHY VIEWS INSTEAD OF THE RENAMES IN SPEC §3.1
-- The spec renames iam_role_actions -> role_permissions and
-- account_group_members -> group_members and keeps compatibility views under the
-- old names. That direction requires renaming two live tables while 129 write
-- sites still address them by their old drizzle objects, in the same release
-- that adds the new engine. Publishing the canonical names as views instead is
-- byte-identical for every reader, needs no writer change, and moves the rename
-- into the cutover PR where the legacy writers are already gone. The cutover
-- step is spelled out in migrations-pending/README.md.
--
-- CORRECTION TO AN EARLIER MIGRATION'S COMMENT (spec §3.6)
-- 20260818120000000_project_role_editor_to_manager.concurrent.ts:15 says the
-- editor->manager fold "follows automatically" through kortix.workspace_members
-- and kortix.workspace_group_grants. Those views DO NOT EXIST on this branch.
-- They were created by 20260726040600000_workspace_domain.sql, which lives only
-- on the unmerged refactor/projects-to-workspaces* branches;
-- kortix_migrations.pgmigrations contains no %workspace% row, and nothing under
-- apps/, packages/ or scripts/ references them. Developer databases that ran
-- that branch still carry them as local residue. The claim is inert (the fold
-- rewrote the base tables, which is all that was ever needed), but it is wrong,
-- and the migration is immutable — editing it fails the `immutability` CI job
-- (.github/workflows/db-migrations.yml), so the correction is recorded here, in
-- the migration that supersedes that model.
--
-- backfill-safe: the only DML is the seed of THREE BRAND-NEW, EMPTY tables
-- (permissions 69 rows, object_policies 5 rows, role_permissions 113 rows) plus
-- 6 role rows. No existing table is read or rewritten, the inserts touch no row
-- another session can hold, and the total is 193 rows of constant data — three
-- orders of magnitude below anything a writer could queue behind.
--
-- mixed-version-safe: three flagged operations, each deliberate.
--   1. `ALTER TABLE kortix.iam_roles ALTER COLUMN account_id DROP NOT NULL`.
--      Dropping NOT NULL only WIDENS what the column accepts. Every existing
--      reader of iam_roles filters `account_id = :accountId`
--      (accounts/iam/custom-roles.ts:113,134,192,231,267,293,339 and the engine's
--      iam_policies join), so a NULL system row is invisible to old code — it can
--      neither be listed, edited, deleted, nor bound by an old replica. Old code
--      never inserts NULL (the route always supplies the path accountId), so no
--      old write can produce a row new code would misread.
--   2. `iam_roles.account_id DROP NOT NULL` is the ONE squawk finding this file
--      carries (ban-drop-not-null). It is deliberate: see 1 above. The other
--      three findings squawk raised on the first draft were real and are fixed —
--      both new indexes moved to a CONCURRENTLY pass and the project_members
--      PRIMARY KEY is now added USING that index instead of scanning the table.
--   3. The FK `iam_role_actions.action -> permissions.action` is added NOT VALID,
--      so no existing row is checked and no old reader changes behaviour. It does
--      constrain NEW inserts: an old replica writing a custom role that contains
--      `project.cr.open`, `project.cr.merge` or a `trigger.*` action would fail
--      with 23503 during the rollout window. Verified those five strings appear
--      in ZERO of the 597 iam_role_actions rows on the local dataset, and both
--      cr.* actions are in NO built-in role (engines.md §18), so only a
--      hand-authored custom role could carry one. VALIDATE is deliberately left
--      to a follow-up migration, per MIGRATIONS.md's expand/contract rule.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- ─── 1. The permission catalog ──────────────────────────────────────────────

CREATE TABLE "kortix"."permissions" (
	"action" varchar(96) PRIMARY KEY NOT NULL,
	"scope_type" varchar(16) NOT NULL,
	"resource_type" varchar(16) NOT NULL,
	"delegable" boolean DEFAULT true NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"area" varchar(32) NOT NULL,
	"level" varchar(16) NOT NULL,
	"implies" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT permissions_scope_type_check CHECK ("scope_type" IN ('account','project')),
	CONSTRAINT permissions_resource_type_check CHECK ("resource_type" IN ('account','project')),
	CONSTRAINT permissions_level_check CHECK ("level" IN ('view','edit','admin'))
);

CREATE INDEX "idx_permissions_scope_area" ON "kortix"."permissions" USING btree ("scope_type","area");

-- ─── 2. Object policies ─────────────────────────────────────────────────────

CREATE TABLE "kortix"."object_policies" (
	"object_type" varchar(16) PRIMARY KEY NOT NULL,
	"unscoped_default_for_member" varchar(8) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT object_policies_default_check
	  CHECK ("unscoped_default_for_member" IN ('open','closed'))
);

-- ─── 3. Assignments ─────────────────────────────────────────────────────────

CREATE TABLE "kortix"."role_assignments" (
	"assignment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"principal_type" varchar(16) NOT NULL,
	"principal_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_type" varchar(16) NOT NULL,
	"scope_id" uuid,
	"object_type" varchar(16),
	"object_id" text,
	"expires_at" timestamp with time zone,
	"granted_by" uuid,
	"source" varchar(16) DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT role_assignments_principal_type_check
	  CHECK ("principal_type" IN ('user','group','service_account','pending')),
	CONSTRAINT role_assignments_scope_type_check
	  CHECK ("scope_type" IN ('account','project')),
	CONSTRAINT role_assignments_source_check
	  CHECK ("source" IN ('manual','scim','sso','invite','system')),
	-- A project-scoped assignment names its project; an account-scoped one
	-- covers every project and must not name one.
	CONSTRAINT role_assignments_scope_shape_check
	  CHECK (("scope_type" = 'project') = ("scope_id" IS NOT NULL)),
	-- object_type and object_id are set together or not at all, and an object
	-- assignment is always project-scoped (an agent lives in a project).
	CONSTRAINT role_assignments_object_shape_check
	  CHECK (
	    ("object_type" IS NULL AND "object_id" IS NULL)
	    OR ("object_type" IS NOT NULL AND "object_id" IS NOT NULL AND "scope_type" = 'project')
	  )
);

ALTER TABLE "kortix"."role_assignments"
  ADD CONSTRAINT "role_assignments_account_id_accounts_account_id_fk"
  FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "kortix"."role_assignments"
  ADD CONSTRAINT "role_assignments_role_id_iam_roles_role_id_fk"
  FOREIGN KEY ("role_id") REFERENCES "kortix"."iam_roles"("role_id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "kortix"."role_assignments"
  ADD CONSTRAINT "role_assignments_object_type_object_policies_fk"
  FOREIGN KEY ("object_type") REFERENCES "kortix"."object_policies"("object_type")
  ON DELETE restrict ON UPDATE no action;

CREATE INDEX "idx_role_assignments_principal" ON "kortix"."role_assignments" USING btree ("principal_type","principal_id");
CREATE INDEX "idx_role_assignments_scope" ON "kortix"."role_assignments" USING btree ("scope_type","scope_id");
CREATE INDEX "idx_role_assignments_role" ON "kortix"."role_assignments" USING btree ("role_id");
CREATE INDEX "idx_role_assignments_account" ON "kortix"."role_assignments" USING btree ("account_id");
CREATE INDEX "idx_role_assignments_expires_at" ON "kortix"."role_assignments" USING btree ("expires_at") WHERE "expires_at" IS NOT NULL;

-- One row per (account, principal, role, scope, object).
--
-- Two departures from spec §1's key, both forced by real data:
--   * account_id is part of the key. §1's key is
--     (principal_type, principal_id, role_id, scope_type, scope_id, object_type,
--     object_id) — but an account-scope assignment has scope_id NULL, so ONE
--     user who is a `member` of two accounts produces two rows the key cannot
--     tell apart. Measured, not theorised: backfilling account_members without
--     account_id in the key collapsed 33,363 memberships to 14,795.
--   * NULLs are coalesced. A plain unique index treats NULLs as distinct, so
--     without this two byte-identical account-scope rows would both be legal —
--     the exact duplicate-binding hole iam_policies has today (no unique at all,
--     and :bulk-import happily creates duplicates).
CREATE UNIQUE INDEX "uq_role_assignments_identity" ON "kortix"."role_assignments" USING btree (
  "account_id",
  "principal_type",
  "principal_id",
  "role_id",
  "scope_type",
  (coalesce("scope_id", '00000000-0000-0000-0000-000000000000'::uuid)),
  (coalesce("object_type", '')),
  (coalesce("object_id", ''))
);

-- ─── 4. Roles: system rows live in iam_roles ────────────────────────────────

ALTER TABLE "kortix"."iam_roles" ALTER COLUMN "account_id" DROP NOT NULL;

-- Account-scoped custom roles keep idx_iam_roles_account_key UNIQUE
-- (account_id, key). System roles have account_id NULL, where that index does
-- not dedupe (NULLs are distinct), and the key `member` legitimately exists at
-- BOTH scopes — so the system uniqueness is (key, scope_type). That index is
-- built CONCURRENTLY by 20260819015724600_rbac_canonical_indexes.concurrent.ts,
-- which runs before the backfill; the seed below is WHERE NOT EXISTS so it
-- cannot create the duplicates that build would then reject.

-- ─── 5. role_permissions gets a real FK to the catalog ──────────────────────
-- First time in this system's history that a role's action list is checked
-- against anything but a JS Set at write time.

ALTER TABLE "kortix"."iam_role_actions"
  ADD CONSTRAINT "role_permissions_action_permissions_fk"
  FOREIGN KEY ("action") REFERENCES "kortix"."permissions"("action")
  ON DELETE restrict ON UPDATE cascade NOT VALID;

-- ─── 6. project_members gets a real primary key ─────────────────────────────
-- Split across two migrations so neither blocks writes: the unique index is
-- built CONCURRENTLY (…724600.concurrent.ts) and promoted to the PRIMARY KEY
-- with ADD CONSTRAINT … USING INDEX (…724700_project_members_primary_key.sql),
-- which takes ACCESS EXCLUSIVE for a catalog update only — no table scan.

-- ─── 7. Seed: the permission catalog ────────────────────────────────────────
-- Generated from apps/api/src/iam/actions.ts (ACCOUNT_ACTIONS + PROJECT_ACTIONS),
-- role-presets.ts (NON_DELEGABLE_ACTIONS -> delegable=false, 17 rows) and the
-- role-capability-matrix area table (area/level/implies), with two catalog
-- decisions from spec §2.4 applied:
--   * project.cr.open / project.cr.merge are GONE — the same capability named
--     twice. They collapse into project.gitops.push / project.gitops.merge,
--     which is what AGENT_ACTION_ALIASES already aliased them to and what the
--     routes already gate the underlying commit on. Neither string appears in
--     any built-in role today, so no role loses a permission.
--   * trigger.read / trigger.update / trigger.delete / trigger.fire are GONE —
--     cataloged, validated, in no role, asserted by no route. Granting one was
--     always a silent no-op; the live spellings are project.trigger.*.
-- 27 account + 42 project = 69 rows.
INSERT INTO kortix.permissions (action, scope_type, resource_type, delegable, area, level, implies) VALUES
('account.read', 'account', 'account', true, 'account', 'view', '{}'::text[]),
  ('account.write', 'account', 'account', true, 'account', 'edit', ARRAY['account.read']::text[]),
  ('account.delete', 'account', 'account', false, 'account', 'edit', ARRAY['account.read','account.write']::text[]),
  ('billing.read', 'account', 'account', true, 'billing', 'view', '{}'::text[]),
  ('billing.write', 'account', 'account', false, 'billing', 'edit', ARRAY['billing.read']::text[]),
  ('audit.read', 'account', 'account', true, 'audit', 'view', '{}'::text[]),
  ('member.read', 'account', 'account', true, 'members', 'view', '{}'::text[]),
  ('member.invite', 'account', 'account', false, 'members', 'edit', ARRAY['member.read']::text[]),
  ('member.update', 'account', 'account', false, 'members', 'edit', ARRAY['member.read']::text[]),
  ('member.remove', 'account', 'account', false, 'members', 'edit', ARRAY['member.read']::text[]),
  ('member.super_admin.grant', 'account', 'account', false, 'members', 'admin', '{}'::text[]),
  ('group.read', 'account', 'account', true, 'groups', 'view', '{}'::text[]),
  ('group.create', 'account', 'account', false, 'groups', 'edit', ARRAY['group.read']::text[]),
  ('group.update', 'account', 'account', false, 'groups', 'edit', ARRAY['group.read']::text[]),
  ('group.delete', 'account', 'account', false, 'groups', 'edit', ARRAY['group.read']::text[]),
  ('group.members.manage', 'account', 'account', false, 'groups', 'edit', ARRAY['group.read']::text[]),
  ('policy.read', 'account', 'account', true, 'roles', 'view', '{}'::text[]),
  ('policy.create', 'account', 'account', false, 'roles', 'edit', ARRAY['role.read','policy.read']::text[]),
  ('policy.delete', 'account', 'account', false, 'roles', 'edit', ARRAY['role.read','policy.read']::text[]),
  ('role.read', 'account', 'account', true, 'roles', 'view', '{}'::text[]),
  ('role.create', 'account', 'account', false, 'roles', 'edit', ARRAY['role.read','policy.read']::text[]),
  ('role.update', 'account', 'account', false, 'roles', 'edit', ARRAY['role.read','policy.read']::text[]),
  ('role.delete', 'account', 'account', false, 'roles', 'edit', ARRAY['role.read','policy.read']::text[]),
  ('token.read', 'account', 'account', true, 'tokens', 'view', '{}'::text[]),
  ('token.create', 'account', 'account', false, 'tokens', 'edit', ARRAY['token.read']::text[]),
  ('token.revoke', 'account', 'account', false, 'tokens', 'edit', ARRAY['token.read']::text[]),
  ('project.create', 'account', 'account', true, 'projects', 'edit', '{}'::text[]),
  ('project.read', 'project', 'project', true, 'project', 'view', '{}'::text[]),
  ('project.write', 'project', 'project', true, 'project', 'edit', ARRAY['project.read']::text[]),
  ('project.delete', 'project', 'project', true, 'project', 'edit', ARRAY['project.read','project.write']::text[]),
  ('project.session.read', 'project', 'project', true, 'sessions', 'view', '{}'::text[]),
  ('project.session.start', 'project', 'project', true, 'sessions', 'edit', ARRAY['project.session.read']::text[]),
  ('project.session.stop', 'project', 'project', true, 'sessions', 'edit', ARRAY['project.session.read']::text[]),
  ('project.session.bindings.write', 'project', 'project', true, 'sessions', 'edit', ARRAY['project.session.read']::text[]),
  ('project.members.read', 'project', 'project', true, 'members', 'view', '{}'::text[]),
  ('project.members.manage', 'project', 'project', true, 'members', 'edit', ARRAY['project.members.read']::text[]),
  ('project.trigger.read', 'project', 'project', true, 'triggers', 'view', '{}'::text[]),
  ('project.trigger.create', 'project', 'project', true, 'triggers', 'edit', ARRAY['project.trigger.read']::text[]),
  ('project.trigger.update', 'project', 'project', true, 'triggers', 'edit', ARRAY['project.trigger.read']::text[]),
  ('project.trigger.delete', 'project', 'project', true, 'triggers', 'edit', ARRAY['project.trigger.read']::text[]),
  ('project.trigger.fire', 'project', 'project', true, 'triggers', 'edit', ARRAY['project.trigger.read']::text[]),
  ('project.gateway.logs.read', 'project', 'project', true, 'spend', 'view', '{}'::text[]),
  ('project.gateway.spend.read', 'project', 'project', true, 'spend', 'view', '{}'::text[]),
  ('project.gateway.budget.set', 'project', 'project', true, 'spend', 'edit', ARRAY['project.gateway.spend.read','project.gateway.logs.read']::text[]),
  ('project.gateway.keys.manage', 'project', 'project', true, 'spend', 'edit', ARRAY['project.gateway.spend.read','project.gateway.logs.read']::text[]),
  ('project.agent.read', 'project', 'project', true, 'customize', 'view', '{}'::text[]),
  ('project.agent.write', 'project', 'project', true, 'customize', 'edit', ARRAY['project.customize.read','project.agent.read','project.skill.read','project.connector.read','project.command.read','project.secret.read']::text[]),
  ('project.skill.read', 'project', 'project', true, 'customize', 'view', '{}'::text[]),
  ('project.skill.write', 'project', 'project', true, 'customize', 'edit', ARRAY['project.customize.read','project.agent.read','project.skill.read','project.connector.read','project.command.read','project.secret.read']::text[]),
  ('project.command.read', 'project', 'project', true, 'customize', 'view', '{}'::text[]),
  ('project.command.write', 'project', 'project', true, 'customize', 'edit', ARRAY['project.customize.read','project.agent.read','project.skill.read','project.connector.read','project.command.read','project.secret.read']::text[]),
  ('project.file.read', 'project', 'project', true, 'files', 'view', '{}'::text[]),
  ('project.file.write', 'project', 'project', true, 'files', 'edit', ARRAY['project.file.read']::text[]),
  ('project.customize.read', 'project', 'project', true, 'customize', 'view', '{}'::text[]),
  ('project.customize.write', 'project', 'project', true, 'customize', 'edit', ARRAY['project.customize.read','project.agent.read','project.skill.read','project.connector.read','project.command.read','project.secret.read']::text[]),
  ('project.gitops.read', 'project', 'project', true, 'git', 'view', '{}'::text[]),
  ('project.gitops.push', 'project', 'project', true, 'git', 'edit', ARRAY['project.gitops.read','project.review.read','project.file.write','project.customize.write','project.agent.write','project.skill.write','project.connector.write','project.connector.connections.manage','project.command.write','project.secret.write','project.trigger.create','project.trigger.update','project.trigger.delete','project.trigger.fire']::text[]),
  ('project.gitops.merge', 'project', 'project', true, 'git', 'edit', ARRAY['project.gitops.read','project.review.read','project.file.write','project.customize.write','project.agent.write','project.skill.write','project.connector.write','project.connector.connections.manage','project.command.write','project.secret.write','project.trigger.create','project.trigger.update','project.trigger.delete','project.trigger.fire']::text[]),
  ('project.secret.read', 'project', 'project', true, 'customize', 'view', '{}'::text[]),
  ('project.secret.write', 'project', 'project', true, 'customize', 'edit', ARRAY['project.customize.read','project.agent.read','project.skill.read','project.connector.read','project.command.read','project.secret.read']::text[]),
  ('project.connector.read', 'project', 'project', true, 'customize', 'view', '{}'::text[]),
  ('project.connector.connections.manage', 'project', 'project', true, 'customize', 'edit', ARRAY['project.customize.read','project.agent.read','project.skill.read','project.connector.read','project.command.read','project.secret.read']::text[]),
  ('project.connector.write', 'project', 'project', true, 'customize', 'edit', ARRAY['project.customize.read','project.agent.read','project.skill.read','project.connector.read','project.command.read','project.secret.read']::text[]),
  ('project.app.read', 'project', 'project', true, 'apps', 'view', '{}'::text[]),
  ('project.app.write', 'project', 'project', true, 'apps', 'edit', ARRAY['project.app.read']::text[]),
  ('project.app.deploy', 'project', 'project', true, 'apps', 'edit', ARRAY['project.app.read']::text[]),
  ('project.review.read', 'project', 'project', true, 'git', 'view', '{}'::text[]),
  ('project.review.submit', 'project', 'project', true, 'git', 'edit', ARRAY['project.gitops.read','project.review.read']::text[]),
  ('project.review.act', 'project', 'project', true, 'git', 'edit', ARRAY['project.gitops.read','project.review.read']::text[]);

-- ─── 8. Seed: object policies ───────────────────────────────────────────────
-- "What does an object with NO grant rows mean for a member-tier caller?"
-- `closed` reproduces isProjectResourceUsableByMember's agent branch exactly;
-- `open` reproduces isResourceAccessible for every other type. app/trigger have
-- no grant rows today and are seeded `open` so adding them changes nothing.
INSERT INTO kortix.object_policies (object_type, unscoped_default_for_member, description) VALUES
  ('agent',   'closed', 'An agent nobody scoped is usable by the manager tier only. A member reaches an agent through an explicit grant.'),
  ('skill',   'open',   'An unscoped skill stays project-wide.'),
  ('secret',  'open',   'An unscoped secret stays project-wide; the agent grant is the gate that matters.'),
  ('app',     'open',   'Reserved. No grants exist; the App access policy is a separate list today.'),
  ('trigger', 'open',   'Reserved. No grants exist.');

-- ─── 9. Seed: the 6 system roles ────────────────────────────────────────────
-- account_id NULL + is_builtin(is_system) true. `agent-user` carries ZERO
-- permissions on purpose: an object grant NARROWS a verdict, it can never add
-- one, so the role that object assignments carry must be empty.
INSERT INTO kortix.iam_roles (account_id, key, name, description, scope_type, is_builtin)
SELECT * FROM (VALUES
  (NULL::uuid, 'owner',      'Owner',            'Full account control.',                                                  'account', true),
  (NULL::uuid, 'admin',      'Admin',            'Manage members, groups, roles and tokens.',                              'account', true),
  (NULL::uuid, 'member',     'Member',           'Baseline account membership.',                                           'account', true),
  (NULL::uuid, 'manager',    'Manager',          'Full project control, including members and delete.',                    'project', true),
  (NULL::uuid, 'member',     'Member (read + run)', 'Read, run sessions, and fire triggers - no editing or config.',       'project', true),
  (NULL::uuid, 'agent-user', 'Object grant',     'Marker role carried by an object assignment. Grants nothing on its own.', 'project', true)
) AS v(account_id, key, name, description, scope_type, is_builtin)
WHERE NOT EXISTS (
  SELECT 1 FROM kortix.iam_roles r
   WHERE r.account_id IS NULL AND r.key = v.key AND r.scope_type = v.scope_type
);

-- ─── 10. Seed: system role -> permissions ───────────────────────────────────
-- Taken verbatim from ACCOUNT_ROLE_PERMS / PROJECT_ROLE_PERMS. Sizes:
-- owner 27, admin 24, member 5 (account); manager 42, member 15 (project);
-- agent-user 0. unit-iam-role-catalog-parity.test.ts pins byte-equality.
INSERT INTO kortix.iam_role_actions (role_id, action)
SELECT r.role_id, v.action
  FROM (VALUES
('owner', 'account', 'account.delete'),
  ('owner', 'account', 'account.read'),
  ('owner', 'account', 'account.write'),
  ('owner', 'account', 'audit.read'),
  ('owner', 'account', 'billing.read'),
  ('owner', 'account', 'billing.write'),
  ('owner', 'account', 'group.create'),
  ('owner', 'account', 'group.delete'),
  ('owner', 'account', 'group.members.manage'),
  ('owner', 'account', 'group.read'),
  ('owner', 'account', 'group.update'),
  ('owner', 'account', 'member.invite'),
  ('owner', 'account', 'member.read'),
  ('owner', 'account', 'member.remove'),
  ('owner', 'account', 'member.super_admin.grant'),
  ('owner', 'account', 'member.update'),
  ('owner', 'account', 'policy.create'),
  ('owner', 'account', 'policy.delete'),
  ('owner', 'account', 'policy.read'),
  ('owner', 'account', 'project.create'),
  ('owner', 'account', 'role.create'),
  ('owner', 'account', 'role.delete'),
  ('owner', 'account', 'role.read'),
  ('owner', 'account', 'role.update'),
  ('owner', 'account', 'token.create'),
  ('owner', 'account', 'token.read'),
  ('owner', 'account', 'token.revoke'),
  ('admin', 'account', 'account.read'),
  ('admin', 'account', 'account.write'),
  ('admin', 'account', 'audit.read'),
  ('admin', 'account', 'billing.read'),
  ('admin', 'account', 'group.create'),
  ('admin', 'account', 'group.delete'),
  ('admin', 'account', 'group.members.manage'),
  ('admin', 'account', 'group.read'),
  ('admin', 'account', 'group.update'),
  ('admin', 'account', 'member.invite'),
  ('admin', 'account', 'member.read'),
  ('admin', 'account', 'member.remove'),
  ('admin', 'account', 'member.update'),
  ('admin', 'account', 'policy.create'),
  ('admin', 'account', 'policy.delete'),
  ('admin', 'account', 'policy.read'),
  ('admin', 'account', 'project.create'),
  ('admin', 'account', 'role.create'),
  ('admin', 'account', 'role.delete'),
  ('admin', 'account', 'role.read'),
  ('admin', 'account', 'role.update'),
  ('admin', 'account', 'token.create'),
  ('admin', 'account', 'token.read'),
  ('admin', 'account', 'token.revoke'),
  ('member', 'account', 'account.read'),
  ('member', 'account', 'billing.read'),
  ('member', 'account', 'group.read'),
  ('member', 'account', 'member.read'),
  ('member', 'account', 'token.read'),
  ('manager', 'project', 'project.agent.read'),
  ('manager', 'project', 'project.agent.write'),
  ('manager', 'project', 'project.app.deploy'),
  ('manager', 'project', 'project.app.read'),
  ('manager', 'project', 'project.app.write'),
  ('manager', 'project', 'project.command.read'),
  ('manager', 'project', 'project.command.write'),
  ('manager', 'project', 'project.connector.connections.manage'),
  ('manager', 'project', 'project.connector.read'),
  ('manager', 'project', 'project.connector.write'),
  ('manager', 'project', 'project.customize.read'),
  ('manager', 'project', 'project.customize.write'),
  ('manager', 'project', 'project.delete'),
  ('manager', 'project', 'project.file.read'),
  ('manager', 'project', 'project.file.write'),
  ('manager', 'project', 'project.gateway.budget.set'),
  ('manager', 'project', 'project.gateway.keys.manage'),
  ('manager', 'project', 'project.gateway.logs.read'),
  ('manager', 'project', 'project.gateway.spend.read'),
  ('manager', 'project', 'project.gitops.merge'),
  ('manager', 'project', 'project.gitops.push'),
  ('manager', 'project', 'project.gitops.read'),
  ('manager', 'project', 'project.members.manage'),
  ('manager', 'project', 'project.members.read'),
  ('manager', 'project', 'project.read'),
  ('manager', 'project', 'project.review.act'),
  ('manager', 'project', 'project.review.read'),
  ('manager', 'project', 'project.review.submit'),
  ('manager', 'project', 'project.secret.read'),
  ('manager', 'project', 'project.secret.write'),
  ('manager', 'project', 'project.session.bindings.write'),
  ('manager', 'project', 'project.session.read'),
  ('manager', 'project', 'project.session.start'),
  ('manager', 'project', 'project.session.stop'),
  ('manager', 'project', 'project.skill.read'),
  ('manager', 'project', 'project.skill.write'),
  ('manager', 'project', 'project.trigger.create'),
  ('manager', 'project', 'project.trigger.delete'),
  ('manager', 'project', 'project.trigger.fire'),
  ('manager', 'project', 'project.trigger.read'),
  ('manager', 'project', 'project.trigger.update'),
  ('manager', 'project', 'project.write'),
  ('member', 'project', 'project.agent.read'),
  ('member', 'project', 'project.app.read'),
  ('member', 'project', 'project.command.read'),
  ('member', 'project', 'project.gateway.logs.read'),
  ('member', 'project', 'project.gateway.spend.read'),
  ('member', 'project', 'project.gitops.read'),
  ('member', 'project', 'project.members.read'),
  ('member', 'project', 'project.read'),
  ('member', 'project', 'project.review.read'),
  ('member', 'project', 'project.review.submit'),
  ('member', 'project', 'project.session.read'),
  ('member', 'project', 'project.session.start'),
  ('member', 'project', 'project.session.stop'),
  ('member', 'project', 'project.trigger.fire'),
  ('member', 'project', 'project.trigger.read')
  ) AS v(key, scope_type, action)
  JOIN kortix.iam_roles r
    ON r.account_id IS NULL AND r.key = v.key AND r.scope_type = v.scope_type
ON CONFLICT (role_id, action) DO NOTHING;

-- ─── 11. The canonical names ────────────────────────────────────────────────
-- Auto-updatable single-table views: SELECT, INSERT (with or without
-- ON CONFLICT, target inferred from the base table's index), UPDATE and DELETE
-- all pass straight through. New code addresses these names; legacy code keeps
-- addressing the physical tables; both see the same rows at all times, which is
-- the property a one-shot copy could not give. The cutover PR swaps which side
-- is physical (migrations-pending/).

CREATE VIEW kortix.roles AS
  SELECT role_id,
         account_id,
         key,
         name,
         description,
         scope_type,
         is_builtin AS is_system,
         created_by,
         created_at,
         updated_at
    FROM kortix.iam_roles;

COMMENT ON VIEW kortix.roles IS
  'Canonical name for kortix.iam_roles. account_id IS NULL = a system role. Write-through.';

CREATE VIEW kortix.role_permissions AS
  SELECT role_id, action FROM kortix.iam_role_actions;

COMMENT ON VIEW kortix.role_permissions IS
  'Canonical name for kortix.iam_role_actions. Write-through.';

CREATE VIEW kortix.group_members AS
  SELECT group_id, user_id, added_by, added_at FROM kortix.account_group_members;

COMMENT ON VIEW kortix.group_members IS
  'Canonical name for kortix.account_group_members. Write-through.';
