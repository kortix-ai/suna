-- Migration: workspace_id_batch_5
--
-- Workspaces M7 (design: .agents/skills/learnings/work/workspaces/design.md §3.3, §6.2).
-- Release 1 EXPAND for Release 2: these tables gain a nullable workspace_id and a
-- BEFORE INSERT OR UPDATE OF account_id trigger that sets it from account_id
-- (kortix.workspace_id_stamp -> kortix.workspace_id_of_account):
--   kortix.roles
--   kortix.scim_tokens
--   kortix.timeline_actions
--   kortix.timeline_audio
--   kortix.timeline_chunks
--   kortix.timeline_frames
--   kortix.yolo_member_tokens
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

ALTER TABLE "kortix"."roles" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER roles_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."roles"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."scim_tokens" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER scim_tokens_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."scim_tokens"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."timeline_actions" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER timeline_actions_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."timeline_actions"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."timeline_audio" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER timeline_audio_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."timeline_audio"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."timeline_chunks" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER timeline_chunks_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."timeline_chunks"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."timeline_frames" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER timeline_frames_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."timeline_frames"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();

ALTER TABLE "kortix"."yolo_member_tokens" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER yolo_member_tokens_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."yolo_member_tokens"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();
