-- Migration: workspace_id_batch_2
--
-- Workspaces M7 (design: .agents/skills/learnings/work/workspaces/design.md §3.3, §6.2).
-- Release 1 EXPAND for Release 2: these tables gain a nullable workspace_id and a
-- BEFORE INSERT OR UPDATE OF account_id trigger that sets it from account_id
-- (kortix.workspace_id_stamp -> kortix.workspace_id_of_account):
--   kortix.account_secret_grants
--   kortix.account_sso_group_mappings
--   kortix.account_sso_providers
--   kortix.app_runtimes
--   kortix.app_site_blobs
--   kortix.app_site_files
-- At most 7 small tables per file, so the file waits for small locks only.
-- kortix.api_keys is hot (every API-key request reads it): it has its own file,
-- 20261106153340000_workspace_id_api_keys.sql, so no other lock wait holds it.
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

ALTER TABLE "kortix"."account_secret_grants" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER account_secret_grants_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."account_secret_grants"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."account_sso_group_mappings" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER account_sso_group_mappings_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."account_sso_group_mappings"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."account_sso_providers" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER account_sso_providers_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."account_sso_providers"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."app_runtimes" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER app_runtimes_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."app_runtimes"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."app_site_blobs" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER app_site_blobs_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."app_site_blobs"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."app_site_files" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER app_site_files_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."app_site_files"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();
