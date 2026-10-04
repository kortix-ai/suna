-- Migration: session_turns
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEW THE GENERATED SQL BELOW. drizzle-kit writes it from the diff between
-- kortix.ts and the snapshot; it knows the target shape, not how to reach it
-- without downtime. Check the same list `migrate:create` prints:
--   [ ] Bare NOT NULL added to an existing populated table (needs a backfill first).
--   [ ] Plain CREATE INDEX / DROP INDEX on an EXISTING table -- move it to
--       `pnpm migrate:create <slug> --concurrent`; it blocks writes here.
--   [ ] New FK/constraint on an existing table -- add NOT VALID, VALIDATE after.
--   [ ] A DROP/RENAME/ALTER ... TYPE the generator proposed from a STALE
--       snapshot. Delete anything already applied by an earlier migration.
--   [ ] Any DROP/RENAME/ALTER ... TYPE/DROP NOT NULL needs the enforced line:
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

-- The committed drizzle snapshot (20260812025340) had forked lineage and was
-- missing every schema change from 20260811120146 onward, so drizzle-kit also
-- proposed re-creating impersonation_grants, project_trigger_session_access_grants,
-- credit_accounts.entitlement_overrides, project_trigger_runtime.session_access_mode,
-- and re-dropping idx_project_sessions_one_available_warm. All five are already
-- applied by their own migrations; they are deleted here. Only the new table
-- remains. The snapshot lineage is repaired in the same commit.

CREATE TABLE "kortix"."session_turns" (
	"turn_token" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"opencode_session_id" text,
	"message_id" text,
	"state" varchar(16) DEFAULT 'delivering' NOT NULL,
	"end_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_turns_state_check" CHECK ("kortix"."session_turns"."state" IN ('delivering', 'active', 'ended')),
	CONSTRAINT "session_turns_end_reason_check" CHECK ("kortix"."session_turns"."end_reason" IS NULL OR "kortix"."session_turns"."end_reason" IN ('completed', 'runtime_gone', 'failed', 'abandoned', 'unknown'))
);
--> statement-breakpoint
CREATE INDEX "session_turns_session_idx" ON "kortix"."session_turns" USING btree ("session_id","started_at" DESC NULLS LAST);--> statement-breakpoint
-- PARTIAL, on the exact predicate the stop writer uses
-- (apps/api/src/projects/reaping/sandbox-state-sync.ts settles every unsettled
-- row of one sandbox inside the stop transaction). Terminal rows are retained
-- forever, so a full index on `state` would grow without bound to answer a
-- question only ever asked about the few rows still open.
CREATE INDEX "session_turns_open_idx" ON "kortix"."session_turns" USING btree ("sandbox_id") WHERE "kortix"."session_turns"."state" <> 'ended';--> statement-breakpoint

-- Take kortix.session_turns OUT of the schema-wide default grants, exactly as
-- 20260811140504477_impersonation_grants_lock_down did for the table created
-- one migration before it.
--
-- The `kortix` schema carries standing default privileges from the baseline
-- (20260621094136410_baseline.sql:22-24: `ALTER DEFAULT PRIVILEGES IN SCHEMA
-- kortix GRANT SELECT, INSERT, UPDATE ON TABLES TO authenticated` / `GRANT
-- SELECT ... TO anon`), and supabase/config.toml exposes the schema through
-- PostgREST. So a table created here is born readable by `anon` and writable by
-- any logged-in user through `/rest/v1/session_turns` with
-- `Accept-Profile: kortix` -- verified on the live local database, where an
-- anon-key GET returned 200 with the row's session_id, account_id and
-- opencode_session_id.
--
-- Every column of this table is internal routing identity: account_id,
-- project_id, sandbox_id, session_id, opencode_session_id, message_id and the
-- per-turn timings of the whole fleet. Nothing outside the API server ever
-- reads it, and a later step reads `state` to answer "is a turn running?", so a
-- client that could INSERT or UPDATE here could fabricate that answer.
-- `postgres` and `service_role` keep full access (the API connects as one of
-- them); every browser-reachable role gets nothing.
REVOKE ALL ON TABLE "kortix"."session_turns" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."session_turns" FROM authenticated;--> statement-breakpoint
-- Belt and braces: if a future blanket `GRANT ... ON ALL TABLES IN SCHEMA
-- kortix` re-adds the privilege, RLS with no policy still denies every row to
-- every non-superuser, non-owner role.
--
-- Deliberately ENABLE and NOT FORCE, for the reason the impersonation_grants
-- lock-down records: FORCE applies RLS to the table OWNER too, and with no
-- policy that would deny every row to the API's own database role in a
-- deployment where it is a plain owner rather than a superuser. The REVOKEs
-- above are the control that matters; ENABLE is the second line.
ALTER TABLE "kortix"."session_turns" ENABLE ROW LEVEL SECURITY;
