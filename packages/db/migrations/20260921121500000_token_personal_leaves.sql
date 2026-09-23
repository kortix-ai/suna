-- Migration: token_personal_leaves
--
-- Adds two account leaves for a person's OWN personal access tokens:
--
--   token.personal.create   mint a personal access token that acts as you
--   token.personal.revoke   revoke a personal access token you minted
--
-- Until now `POST /v1/accounts/tokens` asserted `token.create`, which only
-- `owner` and `admin` hold. A plain member therefore could not run
-- `kortix login` at all: the CLI sign-in page mints a PAT and got 403
-- (reported on a self-hosted deployment 2026-09-21). A PAT authenticates AS
-- the user who minted it (`middleware/auth.ts`, PAT branch) and every request
-- is then authorized against that user's own roles, so minting one grants
-- nothing the person does not already hold in the browser.
--
-- `token.create` / `token.revoke` stay admin leaves. They still gate OAuth
-- client registration, service accounts, and revoking ANOTHER person's token.
--
-- Both new leaves are seeded into `owner`, `admin` and `member` at account
-- scope. They are delegable: holding them lets a principal act only as itself.
-- An account that wants to keep members off the CLI can deny
-- `token.personal.create` with a policy.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- backfill-safe: catalog seed, not a backfill. Literal rows into
-- kortix.permissions (2 rows) and kortix.role_permissions (6 rows: 2 leaves x
-- 3 system account roles). Both are small catalog tables; nothing scans or
-- rewrites user data, and every statement is idempotent via ON CONFLICT.
--
-- Seeds the BASE TABLE kortix.role_permissions: kortix.iam_role_actions is a
-- view and cannot take ON CONFLICT (see 20260901124321557_git_ref_scopes.sql).
-- One statement per (role, action) so the apps/web role-capability-matrix
-- drift alarm can read the seed straight out of this file.

INSERT INTO kortix.permissions
  (action, scope_type, resource_type, delegable, description, area, level, implies)
VALUES
  ('token.personal.create', 'account', 'account', true,
   'Mint a personal access token that acts as you (for example `kortix login`).', 'tokens', 'edit',
   ARRAY['token.read']::text[]),
  ('token.personal.revoke', 'account', 'account', true,
   'Revoke a personal access token you minted.', 'tokens', 'edit',
   ARRAY['token.read']::text[])
ON CONFLICT (action) DO NOTHING;

-- MUST run after the inserts above: role_permissions.action has an FK onto
-- permissions.action.
INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'token.personal.create'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL
   AND r.key = 'owner'
   AND r.scope_type = 'account'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'token.personal.revoke'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL
   AND r.key = 'owner'
   AND r.scope_type = 'account'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'token.personal.create'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL
   AND r.key = 'admin'
   AND r.scope_type = 'account'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'token.personal.revoke'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL
   AND r.key = 'admin'
   AND r.scope_type = 'account'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'token.personal.create'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL
   AND r.key = 'member'
   AND r.scope_type = 'account'
ON CONFLICT (role_id, action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'token.personal.revoke'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL
   AND r.key = 'member'
   AND r.scope_type = 'account'
ON CONFLICT (role_id, action) DO NOTHING;
