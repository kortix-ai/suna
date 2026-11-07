-- Migration: workspaces_table
--
-- Workspaces M4 (design: .agents/skills/learnings/work/workspaces/design.md §3.2 C1, §3.3).
-- Release 1 EXPAND: kortix.workspaces becomes a real TABLE, derived from
-- kortix.accounts, kortix.projects and kortix.account_deletion_requests. It
-- creates new objects only:
--
--   1. DROP VIEW IF EXISTS kortix.workspaces: the first version of M1 created a
--      view of that name on local and branch databases. No shared environment
--      (dev, staging, prod) ever applied it; nothing outside apps/api/src/workspaces
--      read it.
--   2. TABLE kortix.workspaces (C1): CHECKs, the partial unique index (one live
--      row per account unless split_pending), two plain indexes, RLS on.
--   3. TABLE kortix.person_deletion_requests: "Delete my account" keyed by the
--      person (review finding 2), RLS on.
--   4. The C1 functions:
--        kortix.workspaces_expected(account_id)      the live-row rule, the ONE implementation
--        kortix.workspaces_reconcile_account(account_id)  writes it into the table
--        kortix.workspace_id_of_account(account_id)  the live id, NULL when none or ambiguous
--        kortix.workspace_fill_account(account_id)   refills workspace_id on the expand tables
--        kortix.account_is_paying(account_id)        the C6 paying rule
--      plus kortix.workspace_expand_tables() (the 44 tables of §6.2, the one list
--      M7, M8 and the fill share) and kortix.workspace_id_stamp() (the BEFORE
--      trigger function M7 attaches to them).
--
-- The table stays empty until the M5 triggers and the M6 pass fill it. Nothing
-- in Release 1 treats it as the source of truth: the API reads
-- workspaces_expected first and compares the table row (shadow reads, C2).
--
-- Grants: the kortix schema's default privileges apply to the two new tables
-- (20260704160000000_reassert_kortix_runtime_grants.sql). RLS is enabled with
-- no policy, so anon and authenticated read nothing; the API reads as the
-- table owner.
--
-- Locks: only the new objects. DROP VIEW takes ACCESS EXCLUSIVE on the view
-- alone. 3s lock_timeout; on 55P03 the file rolls back: confirm no ledger row,
-- find the holder in pg_stat_activity, rerun the migrate job. Never raise the
-- timeout.
--
-- mixed-version-safe: the only DROP is the local-only view kortix.workspaces of
-- the first M1 draft. No released image names it (it was never merged to dev),
-- and every new object is unknown to the old image.
--
-- ROLL BACK: no down migration (repo policy). A forward migration drops the
-- functions and the two tables; nothing outside the workspaces store reads them.
set lock_timeout = '3s';
set statement_timeout = '30s';

DROP VIEW IF EXISTS "kortix"."workspaces";--> statement-breakpoint

CREATE TABLE "kortix"."person_deletion_requests" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "person_deletion_requests_status_check" CHECK ("kortix"."person_deletion_requests"."status" IN ('pending', 'processing', 'completed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."person_deletion_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kortix"."workspaces" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"legacy_account_id" uuid,
	"former_account_id" uuid,
	"project_id" uuid,
	"lifecycle" text NOT NULL,
	"split_pending" boolean DEFAULT false NOT NULL,
	"name" varchar(255) NOT NULL,
	"repo_url" text,
	"default_branch" varchar(255),
	"manifest_path" text,
	"secret_default_strategy" "kortix"."project_secret_strategy",
	"metadata" jsonb,
	"sandbox_provider_generation" integer,
	"idempotency_key" text,
	"last_opened_at" timestamp with time zone,
	"project_status" "kortix"."project_status",
	"setup_complete_at" timestamp with time zone,
	"setup_wizard_step" integer DEFAULT 0 NOT NULL,
	"mfa_required" boolean DEFAULT false NOT NULL,
	"session_max_lifetime_minutes" integer,
	"session_idle_timeout_minutes" integer,
	"pat_max_lifetime_days" integer,
	"pat_require_expiry" boolean DEFAULT false NOT NULL,
	"pat_idle_revoke_days" integer,
	"admins_see_all_sessions" boolean DEFAULT false NOT NULL,
	"automations_paused_at" timestamp with time zone,
	"automations_paused_by" uuid,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deletion_scheduled_for" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_lifecycle_check" CHECK ("kortix"."workspaces"."lifecycle" IN ('active', 'dormant', 'closing', 'tombstone')),
	CONSTRAINT "workspaces_project_id_check" CHECK ("kortix"."workspaces"."project_id" IS NULL OR "kortix"."workspaces"."project_id" = "kortix"."workspaces"."workspace_id"),
	CONSTRAINT "workspaces_account_key_check" CHECK (("kortix"."workspaces"."lifecycle" = 'tombstone' AND "kortix"."workspaces"."legacy_account_id" IS NULL AND "kortix"."workspaces"."former_account_id" IS NOT NULL AND "kortix"."workspaces"."project_id" IS NOT NULL)
          OR ("kortix"."workspaces"."lifecycle" <> 'tombstone' AND "kortix"."workspaces"."legacy_account_id" IS NOT NULL AND "kortix"."workspaces"."former_account_id" IS NULL)),
	CONSTRAINT "workspaces_active_has_project_check" CHECK ("kortix"."workspaces"."lifecycle" <> 'active' OR "kortix"."workspaces"."project_id" IS NOT NULL),
	CONSTRAINT "workspaces_dormant_has_no_project_check" CHECK ("kortix"."workspaces"."lifecycle" <> 'dormant' OR "kortix"."workspaces"."project_id" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "kortix"."workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "idx_person_deletion_requests_due" ON "kortix"."person_deletion_requests" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspaces_live_account" ON "kortix"."workspaces" USING btree ("legacy_account_id") WHERE "kortix"."workspaces"."lifecycle" <> 'tombstone' AND NOT "kortix"."workspaces"."split_pending";--> statement-breakpoint
CREATE INDEX "idx_workspaces_legacy_account" ON "kortix"."workspaces" USING btree ("legacy_account_id");--> statement-breakpoint
CREATE INDEX "idx_workspaces_former_account" ON "kortix"."workspaces" USING btree ("former_account_id");
--> statement-breakpoint

-- The 44 tables of design.md §6.2 that key on account_id only and gain
-- workspace_id in Release 1 (M7). The one list: packages/db/src/workspace-key-classes.ts
-- holds the same names, and its test compares both.
CREATE OR REPLACE FUNCTION kortix.workspace_expand_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT ARRAY[
    'account_deletion_requests',
    'account_github_installation_states',
    'account_github_installations',
    'account_github_user_tokens',
    'account_groups',
    'account_invitations',
    'account_memberships',
    'account_scim_users',
    'account_secret_grants',
    'account_session_activity',
    'account_sso_group_mappings',
    'account_sso_providers',
    'api_keys',
    'app_runtimes',
    'app_site_blobs',
    'app_site_files',
    'app_volumes',
    'audit_reconciliation_state',
    'audit_webhooks',
    'billing_customers',
    'capture_device_grants',
    'capture_devices',
    'capture_enrollment_tokens',
    'capture_enrollments',
    'capture_workspaces',
    'claude_subscription_logins',
    'cli_device_grants',
    'credit_accounts',
    'credit_ledger',
    'credit_purchases',
    'credit_usage',
    'enterprise_contracts',
    'oauth_access_tokens',
    'oauth_authorization_codes',
    'oauth_clients',
    'provider_events',
    'roles',
    'sandbox_compute_sessions',
    'scim_tokens',
    'timeline_actions',
    'timeline_audio',
    'timeline_chunks',
    'timeline_frames',
    'yolo_member_tokens'
  ]::text[]
$$;--> statement-breakpoint

-- C6: an account pays when it is on a paid tier, bought credits, or holds an
-- active enterprise contract. A stripe_subscription_id alone never counts (149
-- legacy prod accounts carry a stale one on Free).
CREATE OR REPLACE FUNCTION kortix.account_is_paying(p_account_id uuid) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
           SELECT 1 FROM kortix.credit_accounts ca
            WHERE ca.account_id = p_account_id
              AND (coalesce(ca.tier, 'free') NOT IN ('free', 'none')
                   OR ca.lifetime_purchased_precise > 0))
      OR EXISTS (
           SELECT 1 FROM kortix.credit_purchases cp
            WHERE cp.account_id = p_account_id AND cp.status = 'completed')
      OR EXISTS (
           SELECT 1 FROM kortix.enterprise_contracts ec
            WHERE ec.account_id = p_account_id AND ec.status = 'active')
$$;--> statement-breakpoint

-- The live-row rule (C1), per account, in order:
--   1. each active project row is live: 'active', or 'closing' while a deletion
--      request is open (pending or processing). A split_pending account has several.
--   2. else, while a deletion request is open and archived project rows exist:
--      the most recently archived one is live ('closing'), so a deleted
--      workspace keeps its id during the grace.
--   3. else the project-less row (workspace_id = account_id) is live:
--      'dormant', or 'closing'.
--   4. every other project row is a 'tombstone': legacy_account_id NULL,
--      former_account_id set, account settings at their defaults. A tombstone
--      whose project_id equals the account id yields to the project-less row of
--      rule 3 (one id, one row).
-- No row for an account that does not exist.
CREATE OR REPLACE FUNCTION kortix.workspaces_expected(p_account_id uuid) RETURNS SETOF kortix.workspaces
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  WITH acct AS (
    SELECT a.* FROM kortix.accounts a WHERE a.account_id = p_account_id
  ),
  del AS (
    SELECT min(r.scheduled_for) AS scheduled_for
      FROM kortix.account_deletion_requests r
     WHERE r.account_id = p_account_id AND r.status IN ('pending', 'processing')
  ),
  proj AS (
    SELECT p.*,
           row_number() OVER (PARTITION BY p.status ORDER BY p.updated_at DESC, p.project_id DESC) AS recency
      FROM kortix.projects p
     WHERE p.account_id = p_account_id
  ),
  state AS (
    SELECT (SELECT count(*) FROM proj WHERE proj.status = 'active') AS active_count,
           (SELECT count(*) FROM proj WHERE proj.status = 'archived') AS archived_count,
           (SELECT del.scheduled_for FROM del) AS scheduled_for
  ),
  live_project AS (
    SELECT proj.project_id FROM proj WHERE proj.status = 'active'
    UNION ALL
    SELECT proj.project_id FROM proj, state
     WHERE state.active_count = 0 AND state.scheduled_for IS NOT NULL
       AND proj.status = 'archived' AND proj.recency = 1
  ),
  projectless AS (
    SELECT (state.active_count = 0
            AND NOT (state.scheduled_for IS NOT NULL AND state.archived_count > 0)) AS live
      FROM state
  )
  -- Project rows: live (rules 1, 2) or tombstones (rule 4).
  SELECT
    proj.project_id AS workspace_id,
    CASE WHEN lp.project_id IS NOT NULL THEN acct.account_id END AS legacy_account_id,
    CASE WHEN lp.project_id IS NULL THEN acct.account_id END AS former_account_id,
    proj.project_id AS project_id,
    CASE
      WHEN lp.project_id IS NULL THEN 'tombstone'
      WHEN state.scheduled_for IS NOT NULL THEN 'closing'
      ELSE 'active'
    END AS lifecycle,
    (lp.project_id IS NOT NULL AND proj.status = 'active' AND proj.split_pending) AS split_pending,
    proj.name,
    proj.repo_url,
    proj.default_branch,
    proj.manifest_path,
    proj.secret_default_strategy,
    proj.metadata,
    proj.sandbox_provider_generation,
    proj.idempotency_key,
    proj.last_opened_at,
    proj.status AS project_status,
    CASE WHEN lp.project_id IS NOT NULL THEN acct.setup_complete_at END,
    CASE WHEN lp.project_id IS NOT NULL THEN acct.setup_wizard_step ELSE 0 END,
    CASE WHEN lp.project_id IS NOT NULL THEN acct.mfa_required ELSE false END,
    CASE WHEN lp.project_id IS NOT NULL THEN acct.session_max_lifetime_minutes END,
    CASE WHEN lp.project_id IS NOT NULL THEN acct.session_idle_timeout_minutes END,
    CASE WHEN lp.project_id IS NOT NULL THEN acct.pat_max_lifetime_days END,
    CASE WHEN lp.project_id IS NOT NULL THEN acct.pat_require_expiry ELSE false END,
    CASE WHEN lp.project_id IS NOT NULL THEN acct.pat_idle_revoke_days END,
    CASE WHEN lp.project_id IS NOT NULL THEN acct.admins_see_all_sessions ELSE false END,
    CASE WHEN lp.project_id IS NOT NULL THEN acct.automations_paused_at END,
    CASE WHEN lp.project_id IS NOT NULL THEN acct.automations_paused_by END,
    CASE WHEN lp.project_id IS NOT NULL THEN acct.branding ELSE '{}'::jsonb END,
    CASE WHEN lp.project_id IS NOT NULL THEN state.scheduled_for END AS deletion_scheduled_for,
    proj.created_at,
    CASE WHEN lp.project_id IS NOT NULL THEN greatest(proj.updated_at, acct.updated_at) ELSE proj.updated_at END,
    now() AS synced_at
  FROM acct
  CROSS JOIN state
  CROSS JOIN projectless
  JOIN proj ON true
  LEFT JOIN live_project lp ON lp.project_id = proj.project_id
  WHERE NOT (lp.project_id IS NULL AND projectless.live AND proj.project_id = acct.account_id)
  UNION ALL
  -- The project-less row (rule 3).
  SELECT
    acct.account_id, acct.account_id, NULL::uuid, NULL::uuid,
    CASE WHEN state.scheduled_for IS NOT NULL THEN 'closing' ELSE 'dormant' END,
    false,
    acct.name,
    NULL::text, NULL::varchar, NULL::text, NULL::kortix.project_secret_strategy, NULL::jsonb,
    NULL::integer, NULL::text, NULL::timestamptz, NULL::kortix.project_status,
    acct.setup_complete_at, acct.setup_wizard_step, acct.mfa_required,
    acct.session_max_lifetime_minutes, acct.session_idle_timeout_minutes,
    acct.pat_max_lifetime_days, acct.pat_require_expiry, acct.pat_idle_revoke_days,
    acct.admins_see_all_sessions, acct.automations_paused_at, acct.automations_paused_by,
    acct.branding,
    state.scheduled_for,
    acct.created_at, acct.updated_at, now()
  FROM acct
  CROSS JOIN state
  CROSS JOIN projectless
  WHERE projectless.live
$$;--> statement-breakpoint

-- The live id of an account: its one live row when that row is not
-- split_pending. NULL when the account has no live row (unknown or deleted) or
-- several (split_pending). Reads the table: the M7 BEFORE triggers call it on
-- every insert into the expand tables, so it must be one index lookup.
CREATE OR REPLACE FUNCTION kortix.workspace_id_of_account(p_account_id uuid) RETURNS uuid
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN count(*) = 1 AND NOT bool_or(w.split_pending) THEN (array_agg(w.workspace_id))[1] END
    FROM kortix.workspaces w
   WHERE w.legacy_account_id = p_account_id AND w.lifecycle <> 'tombstone'
$$;--> statement-breakpoint

-- Refill workspace_id on every expand-table row of one account (the tables of
-- workspace_expand_tables() that already carry the column) to
-- workspace_id_of_account. Returns the number of rows changed. The split calls
-- it after an account's last move; the reconcile calls it when an account's
-- live id moves from one id to another (a new workspace's first project).
CREATE OR REPLACE FUNCTION kortix.workspace_fill_account(p_account_id uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_id uuid := kortix.workspace_id_of_account(p_account_id);
  v_table text;
  v_rows integer;
  v_total integer := 0;
BEGIN
  IF p_account_id IS NULL THEN
    RETURN 0;
  END IF;
  FOR v_table IN
    SELECT t.name
      FROM unnest(kortix.workspace_expand_tables()) AS t(name)
     WHERE EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = to_regclass('kortix.' || quote_ident(t.name))
          AND a.attname = 'workspace_id' AND NOT a.attisdropped)
  LOOP
    EXECUTE format(
      'UPDATE kortix.%I SET workspace_id = $1 WHERE account_id = $2 AND workspace_id IS DISTINCT FROM $1',
      v_table)
      USING v_id, p_account_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_total := v_total + v_rows;
  END LOOP;
  RETURN v_total;
END;
$$;--> statement-breakpoint

-- Write workspaces_expected(account) into the table and delete the account's
-- other rows. Idempotent: a row whose content (synced_at aside) is unchanged
-- is not touched; a changed row is deleted and inserted again.
--
-- Locks, in this order:
--   1. the account row, FOR NO KEY UPDATE. Writers lock a project row before
--      its account row (projects/lib/workspace-name.ts), and the triggers that
--      call this run after the row they fire on is locked, so taking the
--      account row here keeps that one order. FOR NO KEY UPDATE does not block
--      foreign-key checks (FOR KEY SHARE) of rows that reference the account.
--   2. pg_advisory_xact_lock('kortix:workspaces:' || account_id): serializes
--      the reconcile of an account whose row is gone (the deletion sweep).
-- Every statement after the locks reads a fresh snapshot (READ COMMITTED), so
-- two concurrent writers of one account never write a stale row set.
CREATE OR REPLACE FUNCTION kortix.workspaces_reconcile_account(p_account_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_before uuid;
  v_after uuid;
BEGIN
  IF p_account_id IS NULL THEN
    RETURN;
  END IF;
  PERFORM 1 FROM kortix.accounts a WHERE a.account_id = p_account_id FOR NO KEY UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('kortix:workspaces:' || p_account_id::text, 0));

  v_before := kortix.workspace_id_of_account(p_account_id);

  -- Delete every row of the account that differs from its expected row (or
  -- has none), then insert what is missing. A changed row is rewritten, not
  -- updated in place: an in-place update of two rows of one account (a
  -- tombstone coming back live while the live row turns tombstone) would
  -- collide on uq_workspaces_live_account between the two rows.
  DELETE FROM kortix.workspaces w
   WHERE (w.legacy_account_id = p_account_id OR w.former_account_id = p_account_id)
     AND NOT EXISTS (
       SELECT 1 FROM kortix.workspaces_expected(p_account_id) e
        WHERE e.workspace_id = w.workspace_id
          AND (to_jsonb(e.*) - 'synced_at') = (to_jsonb(w.*) - 'synced_at'));

  -- A conflict here is a row of the same id that belongs to another account
  -- (a project row moved by the transfer): it moves to this account.
  INSERT INTO kortix.workspaces AS w
  SELECT * FROM kortix.workspaces_expected(p_account_id)
  ON CONFLICT (workspace_id) DO UPDATE
     SET legacy_account_id = EXCLUDED.legacy_account_id,
           former_account_id = EXCLUDED.former_account_id,
           project_id = EXCLUDED.project_id,
           lifecycle = EXCLUDED.lifecycle,
           split_pending = EXCLUDED.split_pending,
           name = EXCLUDED.name,
           repo_url = EXCLUDED.repo_url,
           default_branch = EXCLUDED.default_branch,
           manifest_path = EXCLUDED.manifest_path,
           secret_default_strategy = EXCLUDED.secret_default_strategy,
           metadata = EXCLUDED.metadata,
           sandbox_provider_generation = EXCLUDED.sandbox_provider_generation,
           idempotency_key = EXCLUDED.idempotency_key,
           last_opened_at = EXCLUDED.last_opened_at,
           project_status = EXCLUDED.project_status,
           setup_complete_at = EXCLUDED.setup_complete_at,
           setup_wizard_step = EXCLUDED.setup_wizard_step,
           mfa_required = EXCLUDED.mfa_required,
           session_max_lifetime_minutes = EXCLUDED.session_max_lifetime_minutes,
           session_idle_timeout_minutes = EXCLUDED.session_idle_timeout_minutes,
           pat_max_lifetime_days = EXCLUDED.pat_max_lifetime_days,
           pat_require_expiry = EXCLUDED.pat_require_expiry,
           pat_idle_revoke_days = EXCLUDED.pat_idle_revoke_days,
           admins_see_all_sessions = EXCLUDED.admins_see_all_sessions,
           automations_paused_at = EXCLUDED.automations_paused_at,
           automations_paused_by = EXCLUDED.automations_paused_by,
           branding = EXCLUDED.branding,
           deletion_scheduled_for = EXCLUDED.deletion_scheduled_for,
           created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at,
           synced_at = EXCLUDED.synced_at
   WHERE (to_jsonb(w.*) - 'synced_at') IS DISTINCT FROM (to_jsonb(EXCLUDED.*) - 'synced_at');

  v_after := kortix.workspace_id_of_account(p_account_id);
  -- A live id that moves from one id to another (the dormant row of a new
  -- account to its first project) re-stamps the account's expand rows. A move
  -- from NULL (split_pending, or no row yet) is left to the split runner and
  -- the M8 fill: a keeper account can hold millions of ledger rows.
  IF v_before IS NOT NULL AND v_after IS NOT NULL AND v_before <> v_after THEN
    PERFORM kortix.workspace_fill_account(p_account_id);
  END IF;
END;
$$;--> statement-breakpoint

-- The BEFORE INSERT OR UPDATE OF account_id trigger function of the expand
-- tables (M7): workspace_id follows account_id.
CREATE OR REPLACE FUNCTION kortix.workspace_id_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.workspace_id := kortix.workspace_id_of_account(NEW.account_id);
  RETURN NEW;
END;
$$;
