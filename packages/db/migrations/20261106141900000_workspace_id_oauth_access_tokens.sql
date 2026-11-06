-- Migration: workspace_id_oauth_access_tokens
--
-- Workspaces M7 (design: .agents/skills/learnings/work/workspaces/design.md §3.3, §6.2).
-- Release 1 EXPAND for Release 2: this hot table gains a nullable workspace_id and a
-- BEFORE INSERT OR UPDATE OF account_id trigger that sets it from account_id
-- (kortix.workspace_id_stamp -> kortix.workspace_id_of_account):
--   kortix.oauth_access_tokens
-- One hot table per file, so the file waits for one lock only.
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
-- trigger (DROP TRIGGER IF EXISTS <table>_workspace_id_stamp ON kortix.<table>);
-- the column can stay, nothing reads it.
set lock_timeout = '3s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."oauth_access_tokens" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

CREATE OR REPLACE TRIGGER oauth_access_tokens_workspace_id_stamp
  BEFORE INSERT OR UPDATE OF account_id ON "kortix"."oauth_access_tokens"
  FOR EACH ROW EXECUTE FUNCTION kortix.workspace_id_stamp();
