-- Migration: workspaces_expand
--
-- Workspaces M1 (design: .agents/skills/learnings/work/workspaces/design.md §1.2, §2).
-- A workspace is ONE account and its ONE active project. This migration only
-- ADDS objects:
--   1. kortix.projects.split_pending  boolean NOT NULL DEFAULT false
--      (metadata-only on PG 11+: no table rewrite).
--   2. kortix.workspace_name_backups and kortix.workspace_split_runs (new, empty).
--   3. VIEW kortix.workspaces: one row per active project, joined to its account.
--   4. Triggers projects_name_sync and accounts_name_sync: a rename of either
--      row of a 1:1 workspace renames the other.
-- The unique index uq_projects_workspace_account is built CONCURRENTLY in
-- 20261105203912000_workspaces_one_per_account.concurrent.ts, after
-- 20261105203911000_workspaces_mark_and_name.concurrent.ts marks the legacy
-- multi-project accounts split_pending.
--
-- Locks: ALTER TABLE projects ADD COLUMN and CREATE TRIGGER take ACCESS
-- EXCLUSIVE / SHARE ROW EXCLUSIVE on kortix.projects (~9.5k rows on prod, hot
-- reads) and SHARE ROW EXCLUSIVE on kortix.accounts, held until the batch
-- commits. The 3s lock_timeout makes a busy table fail fast with 55P03 instead
-- of queueing every reader behind it; the deploy then re-runs the migrate job.
-- projects is locked before accounts: the same order as the API's rename path
-- (projects/lib/workspace-name.ts updates the project, then the account).
--
-- Mixed-version deploy: old API images never name split_pending, the view, the
-- two tables or the trigger functions. The triggers fire only on
-- `UPDATE OF name` when the name changes, and write only the other row's name
-- (and updated_at) of an account with exactly 1 active project. An old pod
-- that renames a 1:1 project now also renames its account, and the reverse.
-- That is the intended workspace behavior; no old code path reads the two
-- names as independent values for a 1:1 account.
--
-- ROLL BACK: no down migration (repo policy). Every object is additive; an
-- older image ignores them. To stop the name mirroring, a forward migration
-- drops the two triggers.
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

-- security_invoker: a read through the view is checked against the RLS and
-- grants of kortix.projects and kortix.accounts, as the caller. accounts.name
-- is deliberately absent: projects.name is the one workspace name.
CREATE VIEW "kortix"."workspaces" WITH (security_invoker = true) AS
SELECT
  p.project_id AS workspace_id,
  p.account_id,
  p.name,
  p.repo_url,
  p.default_branch,
  p.manifest_path,
  p.status,
  p.secret_default_strategy,
  p.metadata,
  p.sandbox_provider_generation,
  p.last_opened_at,
  p.created_at,
  p.updated_at,
  p.split_pending,
  a.setup_complete_at,
  a.setup_wizard_step,
  a.mfa_required,
  a.session_max_lifetime_minutes,
  a.session_idle_timeout_minutes,
  a.pat_max_lifetime_days,
  a.pat_require_expiry,
  a.pat_idle_revoke_days,
  a.admins_see_all_sessions,
  a.automations_paused_at,
  a.automations_paused_by,
  a.branding
FROM kortix.projects p
JOIN kortix.accounts a ON a.account_id = p.account_id
WHERE p.status = 'active';--> statement-breakpoint

-- A view has its own ACL. Roles that may read kortix.projects may read the view
-- (the same copy 20261001225220282_audit_events_all_view.sql does).
DO $$
DECLARE
  grant_row record;
BEGIN
  FOR grant_row IN
    SELECT a.grantee, string_agg(DISTINCT a.privilege_type, ', ') AS privileges
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid = 'kortix.projects'::regclass
       AND a.grantee <> 0
       AND a.privilege_type = 'SELECT'
     GROUP BY a.grantee
  LOOP
    EXECUTE format('GRANT %s ON kortix.workspaces TO %I',
                   grant_row.privileges, (SELECT rolname FROM pg_roles WHERE oid = grant_row.grantee));
  END LOOP;
END;
$$;--> statement-breakpoint

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

-- accounts.name -> projects.name of the account's only active project.
CREATE FUNCTION kortix.workspace_account_name_sync() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF pg_trigger_depth() >= 2 THEN
    RETURN NULL;
  END IF;
  IF (SELECT count(*) FROM kortix.projects p
       WHERE p.account_id = NEW.account_id AND p.status = 'active') <> 1 THEN
    RETURN NULL;
  END IF;
  UPDATE kortix.projects p
     SET name = NEW.name, updated_at = now()
   WHERE p.account_id = NEW.account_id
     AND p.status = 'active'
     AND p.name IS DISTINCT FROM NEW.name;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER projects_name_sync
  AFTER UPDATE OF name ON kortix.projects
  FOR EACH ROW
  WHEN (NEW.name IS DISTINCT FROM OLD.name)
  EXECUTE FUNCTION kortix.workspace_project_name_sync();--> statement-breakpoint

CREATE TRIGGER accounts_name_sync
  AFTER UPDATE OF name ON kortix.accounts
  FOR EACH ROW
  WHEN (NEW.name IS DISTINCT FROM OLD.name)
  EXECUTE FUNCTION kortix.workspace_account_name_sync();
