-- Migration: workspace_id_batch_1
--
-- Workspaces M7 (design: .agents/skills/learnings/work/workspaces/design.md §3.3, §6.2).
-- Release 1 EXPAND for Release 2: these tables gain a nullable workspace_id and a
-- BEFORE INSERT OR UPDATE OF account_id trigger that sets it from account_id
-- (kortix.workspace_id_stamp -> kortix.workspace_id_of_account):
--   kortix.account_deletion_requests
--   kortix.account_github_installation_states
--   kortix.account_github_installations
--   kortix.account_github_user_tokens
--   kortix.account_groups
--   kortix.account_invitations
--   kortix.account_scim_users
-- At most 7 small tables per file, so the file waits for small locks only.
-- Existing rows stay NULL here; the throttled background job workspace-id-fill
-- (apps/api/src/workspaces/id-fill.ts) fills them after the deploy, never the
-- migrate job. No index on workspace_id in Release 1: nothing reads it
-- until Release 2.
--
-- Locks: ADD COLUMN (nullable, no default: catalog-only, no rewrite) takes
-- ACCESS EXCLUSIVE for a moment; CREATE TRIGGER takes SHARE ROW EXCLUSIVE. Both
-- are held until this file commits. 3s lock_timeout: on 55P03 the file rolls
-- back as a whole: confirm no ledger row, find the holder in pg_stat_activity,
-- rerun the migrate job. Never raise the timeout. IF NOT EXISTS and CREATE OR
-- REPLACE make a rerun safe.
--
-- Mixed-version deploy: the old image never names workspace_id on these
-- tables. The trigger only sets a column the old image never reads; an INSERT
-- of the old image gets the value set for it. On an update that does not name
-- account_id, the trigger does not fire.
--
-- ROLL BACK: no down migration (repo policy). A forward migration drops the
-- triggers (DROP TRIGGER IF EXISTS <table>_workspace_id_stamp ON kortix.<table>);
-- the column can stay, nothing reads it.
set lock_timeout = '3s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."account_deletion_requests" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER account_deletion_requests_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."account_deletion_requests"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."account_github_installation_states" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER account_github_installation_states_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."account_github_installation_states"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."account_github_installations" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER account_github_installations_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."account_github_installations"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."account_github_user_tokens" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER account_github_user_tokens_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."account_github_user_tokens"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."account_groups" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER account_groups_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."account_groups"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."account_invitations" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER account_invitations_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."account_invitations"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."account_scim_users" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER account_scim_users_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."account_scim_users"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();
