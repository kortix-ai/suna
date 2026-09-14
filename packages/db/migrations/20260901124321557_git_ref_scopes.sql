-- Migration: git_ref_scopes
--
-- Adds the two git ref-authority leaves the git proxy's ref policy consults:
--
--   project.gitops.ref.any      push refs beyond your own session branch
--   project.gitops.ref.delete   delete a ref
--
-- Until now git authorization was one boolean for the whole repository, so a
-- session credential could push, force-rewrite or delete ANY ref (verified on
-- dev 2026-08-31). The proxy now scopes a session to its own branch
-- structurally — that binding is the credential's identity, not a permission,
-- and is deliberately NOT expressible here. These leaves are what a role or a
-- `kortix_cli` grant hands to a principal that must act outside that lane.
--
-- Naming follows the `git` group's existing family. Spec §2.4 collapsed
-- project.cr.open / project.cr.merge into the gitops leaves because they were
-- the same capability named twice; these extend that one family rather than
-- forking a second git vocabulary.
--
-- Both are seeded into the built-in project `manager` role only, matching
-- project.gitops.push / .merge. No existing role loses anything, and no
-- principal gains anything it could not already do: today every non-session
-- caller may push and delete any ref, so `manager` holding both leaves is the
-- status quo written down. Sessions are unaffected — they hold neither.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- backfill-safe: catalog seed, not a backfill. Two INSERTs of literal rows into
-- kortix.permissions (2 rows) and kortix.role_permissions (2 rows, one per leaf
-- for each role that already holds project.gitops.push). Both are small catalog
-- tables — permissions is one row per action — the statements touch no user
-- data, scan nothing, and are idempotent via ON CONFLICT DO NOTHING. The
-- 2026-08-10 v0.12.7 rule this annotation answers is about rewriting rows of a
-- hot table under an ACCESS EXCLUSIVE lock; nothing here rewrites a row.
--
-- Written against the LIVE schema, not against the RBAC cutover migration that
-- created these tables. Two things have moved since and both were caught only
-- by running this SQL against a real database:
--   * kortix.permissions columns are (delegable, description, area, level) —
--     the cutover's (grantable, "group", verb) were renamed and one was added.
--   * kortix.iam_role_actions is now a VIEW over kortix.role_permissions, and a
--     view has no unique index, so `ON CONFLICT` against it fails 42P10 (see
--     the 2026-08-19 learning). Seed the base table, keyed by role_id. The
--     20260819015727000 precedent still names the view because it ran BEFORE
--     the view cutover later the same day; copying it verbatim today would
--     fail.
--
-- One statement per (role, action), rather than a set-derived INSERT, so the
-- role-capability-matrix drift alarm in apps/web can read what this seeds
-- straight out of the SQL. `manager` is the only role holding
-- project.gitops.push (verified against the live catalog).

INSERT INTO kortix.permissions
  (action, scope_type, resource_type, delegable, description, area, level, implies)
VALUES
  ('project.gitops.ref.any', 'project', 'project', true,
   'Push Git refs beyond your own session branch.', 'git', 'edit',
   ARRAY['project.gitops.read','project.gitops.push']::text[]),
  ('project.gitops.ref.delete', 'project', 'project', true,
   'Delete a Git ref.', 'git', 'edit',
   ARRAY['project.gitops.read','project.gitops.push']::text[])
ON CONFLICT (action) DO NOTHING;

-- MUST run after the inserts above: role_permissions.action has an FK onto
-- permissions.action.
INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'project.gitops.ref.any'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL
   AND r.key = 'manager'
   AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'project.gitops.ref.delete'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL
   AND r.key = 'manager'
   AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;
