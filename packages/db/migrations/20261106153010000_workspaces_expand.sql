-- Migration: workspaces_expand
--
-- Workspaces M1 (design: .agents/skills/learnings/work/workspaces/design.md §3.3).
-- A workspace is ONE account and its ONE active project. This migration only
-- ADDS objects, and it locks ONE hot table (kortix.projects):
--   1. kortix.projects.split_pending  boolean NOT NULL DEFAULT false
--      (metadata-only on PG 11+: no table rewrite).
--   2. kortix.workspace_name_backups and kortix.workspace_split_runs (new, empty).
--   3. Trigger projects_name_sync: a rename of the project of a 1:1 workspace
--      renames its account.
-- The reverse direction (accounts_name_sync) is in its own file,
-- 20261106153040000_workspaces_account_name_sync.sql, so each file waits
-- for the lock of one hot table only (review finding 29). kortix.workspaces is
-- a TABLE, created by 20261106153100000_workspaces_table.sql.
-- The unique index uq_projects_workspace_account is built CONCURRENTLY in
-- 20261106153030000_workspaces_one_per_account.concurrent.ts, after
-- 20261106153020000_workspaces_mark_and_name.concurrent.ts marks the legacy
-- multi-project accounts split_pending.
--
-- Locks: ALTER TABLE projects ADD COLUMN takes ACCESS EXCLUSIVE and CREATE
-- TRIGGER SHARE ROW EXCLUSIVE on kortix.projects (~9.5k rows on prod, hot
-- reads), held until this file commits. The 3s lock_timeout makes a busy table
-- fail fast with 55P03 instead of queueing every reader behind it.
-- On 55P03 this file rolls back as a whole (each file is its own transaction,
-- RUNNER_TRANSACTION_MODE): confirm no ledger row and no split_pending column,
-- find the holder in pg_stat_activity, and rerun the migrate job (Promote /
-- deploy migrate-db). Never raise the timeout. There is no automatic retry
-- on 55P03 (packages/db/scripts/migration-retry.ts retries 40P01 and the
-- advisory lock only).
--
-- Mixed-version deploy: old API images never name split_pending, the two
-- tables or the trigger function. The trigger fires only on `UPDATE OF name`
-- when the name changes, and writes only the account name (and updated_at) of
-- an account with exactly 1 active project. An old pod that renames a 1:1
-- project now also renames its account. That is the intended workspace
-- behavior; no old code path reads the two names as independent values for a
-- 1:1 account.
--
-- ROLL BACK: no down migration (repo policy). Every object is additive; an
-- older image ignores them. To stop the name mirroring, a forward migration
-- drops the trigger.
set lock_timeout = '3s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."projects" ADD COLUMN "split_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint

CREATE TABLE "kortix"."workspace_name_backups" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"old_name" varchar(255) NOT NULL,
	"new_name" varchar(255) NOT NULL,
	"backfilled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."workspace_name_backups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kortix"."workspace_split_runs" (
	"run_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"from_account_id" uuid NOT NULL,
	"to_account_id" uuid,
	"phase" varchar(32) DEFAULT 'planned' NOT NULL,
	"mode" varchar(16) DEFAULT 'dry_run' NOT NULL,
	"plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"copied_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "kortix"."workspace_split_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "idx_workspace_split_runs_project" ON "kortix"."workspace_split_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_split_runs_from_account" ON "kortix"."workspace_split_runs" USING btree ("from_account_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_split_runs_phase_heartbeat" ON "kortix"."workspace_split_runs" USING btree ("phase","heartbeat_at");--> statement-breakpoint

-- projects.name -> accounts.name, only for an account with exactly 1 active
-- project (a 1:1 workspace). pg_trigger_depth() < 2: the account update below
-- fires accounts_name_sync at depth 2, which returns at once (no ping-pong).
CREATE FUNCTION kortix.workspace_project_name_sync() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF pg_trigger_depth() >= 2 OR NEW.status <> 'active' THEN
    RETURN NULL;
  END IF;
  IF (SELECT count(*) FROM kortix.projects p
       WHERE p.account_id = NEW.account_id AND p.status = 'active') <> 1 THEN
    RETURN NULL;
  END IF;
  UPDATE kortix.accounts a
     SET name = NEW.name, updated_at = now()
   WHERE a.account_id = NEW.account_id
     AND a.name IS DISTINCT FROM NEW.name;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER projects_name_sync
  AFTER UPDATE OF name ON kortix.projects
  FOR EACH ROW
  WHEN (NEW.name IS DISTINCT FROM OLD.name)
  EXECUTE FUNCTION kortix.workspace_project_name_sync();
