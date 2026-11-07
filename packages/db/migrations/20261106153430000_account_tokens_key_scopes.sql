-- Migration: account_tokens_key_scopes
--
-- Workspaces auth (design: .agents/skills/learnings/work/workspaces/design.md
-- §3.2 C4a). Two nullable columns on account_tokens:
--   scopes             what a workspace key may do, inside its creator's role:
--                      {"preset":"read"} (every *.read action) or
--                      {"permissions":[...]} (a custom list). NULL = the
--                      creator's whole role ('full'), as every key minted before.
--   expiry_renew_days  a renewing expiry: each use moves expires_at to now() +
--                      this many days (the CLI device login). NULL = a fixed
--                      expiry, as every key minted before.
-- The API checks the scope on every request (iam/key-scope.ts) and the creator's
-- current role in the same authorize call, so a key never exceeds the role.
--
-- Locks: ADD COLUMN (nullable, no default: catalog-only, no rewrite) takes
-- ACCESS EXCLUSIVE on account_tokens for a moment. account_tokens is read on
-- every PAT request: one hot table, one file. 3s lock_timeout: on 55P03 the
-- file rolls back as a whole: find the holder in pg_stat_activity, rerun the
-- migrate job. Never raise the timeout. IF NOT EXISTS makes a rerun safe.
--
-- Mixed-version deploy: the old image never names the two columns. An old pod
-- authorizes a scoped key as a full key for the rollout window (minutes): the
-- key still never exceeds its creator's role. Every existing row stays NULL.
--
-- ROLL BACK: no down migration (repo policy). The columns can stay: nothing but
-- the new image reads them.
set lock_timeout = '3s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."account_tokens" ADD COLUMN IF NOT EXISTS "scopes" jsonb;
ALTER TABLE "kortix"."account_tokens" ADD COLUMN IF NOT EXISTS "expiry_renew_days" integer;

COMMENT ON COLUMN "kortix"."account_tokens"."scopes" IS
  'Workspace key scope inside the creator''s role: {"preset":"read"} or {"permissions":[...]}. NULL = the creator''s whole role.';
COMMENT ON COLUMN "kortix"."account_tokens"."expiry_renew_days" IS
  'Renewing expiry: each use sets expires_at = now() + this many days. NULL = fixed expiry.';
