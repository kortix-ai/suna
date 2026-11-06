-- Migration: workspace_id_batch_3
--
-- Workspaces M7 (design: .agents/skills/learnings/work/workspaces/design.md §3.3, §6.2).
-- Release 1 EXPAND for Release 2: these tables gain a nullable workspace_id and a
-- BEFORE INSERT OR UPDATE OF account_id trigger that sets it from account_id
-- (kortix.workspace_id_stamp -> kortix.workspace_id_of_account):
--   kortix.app_volumes
--   kortix.audit_reconciliation_state
--   kortix.audit_webhooks
--   kortix.capture_device_grants
--   kortix.capture_devices
--   kortix.capture_enrollment_tokens
--   kortix.capture_enrollments
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

ALTER TABLE "kortix"."app_volumes" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER app_volumes_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."app_volumes"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."audit_reconciliation_state" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER audit_reconciliation_state_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."audit_reconciliation_state"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."audit_webhooks" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER audit_webhooks_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."audit_webhooks"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."capture_device_grants" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER capture_device_grants_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."capture_device_grants"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."capture_devices" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER capture_devices_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."capture_devices"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."capture_enrollment_tokens" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER capture_enrollment_tokens_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."capture_enrollment_tokens"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."capture_enrollments" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER capture_enrollments_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."capture_enrollments"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();
