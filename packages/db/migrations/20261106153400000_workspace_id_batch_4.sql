-- Migration: workspace_id_batch_4
--
-- Workspaces M7 (design: .agents/skills/learnings/work/workspaces/design.md §3.3, §6.2).
-- Release 1 EXPAND for Release 2: these tables gain a nullable workspace_id and a
-- BEFORE INSERT OR UPDATE OF account_id trigger that sets it from account_id
-- (kortix.workspace_id_stamp -> kortix.workspace_id_of_account):
--   kortix.capture_workspaces
--   kortix.claude_subscription_logins
--   kortix.cli_device_grants
--   kortix.enterprise_contracts
--   kortix.oauth_authorization_codes
--   kortix.oauth_clients
--   kortix.provider_events
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

ALTER TABLE "kortix"."capture_workspaces" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER capture_workspaces_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."capture_workspaces"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."claude_subscription_logins" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER claude_subscription_logins_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."claude_subscription_logins"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."cli_device_grants" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER cli_device_grants_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."cli_device_grants"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."enterprise_contracts" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER enterprise_contracts_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."enterprise_contracts"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."oauth_authorization_codes" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER oauth_authorization_codes_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."oauth_authorization_codes"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."oauth_clients" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER oauth_clients_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."oauth_clients"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."provider_events" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER provider_events_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."provider_events"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();
