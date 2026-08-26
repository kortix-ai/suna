-- Migration: session_runtime_projections
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEWED. drizzle-kit generated exactly the CREATE TABLE + FK + INDEX below
-- from the kortix.ts diff; nothing was edited out. Two additions at the bottom
-- (the grant lock-down and RLS), for the reason
-- 20260826064400234_session_transcript_mirror.sql records: the `kortix` schema
-- carries standing default privileges from the baseline
-- (20260621094136410_baseline.sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA kortix
-- GRANT SELECT, INSERT, UPDATE ON TABLES TO authenticated` / `GRANT SELECT ...
-- TO anon`) and supabase/config.toml exposes the schema through PostgREST, so a
-- table created here is BORN READABLE by `anon`. This one holds every project's
-- agent roster, command roster, model configuration and pending
-- permission/question ids -- account data, reachable with nothing but the anon
-- key. Same treatment as the transcript mirror and session_turns.
--
-- The table is NEW, so the FK and the index below are created on an EMPTY
-- relation: no CONCURRENTLY needed, no lock held over live rows, and there is
-- no backfill DML anywhere in this file (the 2026-08-10 v0.12.7 rule).
--
--   [x] No bare NOT NULL added to an existing populated table.
--   [x] No CREATE/DROP INDEX on an EXISTING table.
--   [x] No FK/constraint added to an existing table.
--   [x] No DROP / RENAME / ALTER TYPE / DROP NOT NULL anywhere, so no
--       `mixed-version-safe:` or `enum-value-checked:` line is required. Old
--       API pods simply never read or write this table.

CREATE TABLE "kortix"."session_runtime_projections" (
	"session_id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"opencode_session_id" text,
	"opencode_version" text,
	"agent_config_etag" text,
	"daemon_build" bigint,
	"epoch" text,
	"seq" bigint,
	"head_seq" jsonb,
	"projection_etag" text NOT NULL,
	"projection" jsonb NOT NULL,
	"source" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."session_runtime_projections" ADD CONSTRAINT "session_runtime_projections_session_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_runtime_projections_project_idx" ON "kortix"."session_runtime_projections" USING btree ("project_id");;--> statement-breakpoint

-- Take the table OUT of the schema-wide default grants (see the header). An
-- anon-key GET against `/rest/v1/session_runtime_projections` with
-- `Accept-Profile: kortix` would otherwise return every account's agent roster
-- and model configuration. `postgres` and `service_role` keep full access --
-- the API connects as one of them; every browser-reachable role gets nothing.
REVOKE ALL ON TABLE "kortix"."session_runtime_projections" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."session_runtime_projections" FROM authenticated;--> statement-breakpoint

-- Belt and braces: if a future blanket `GRANT ... ON ALL TABLES IN SCHEMA
-- kortix` re-adds the privilege, RLS with no policy still denies every row to
-- every non-superuser, non-owner role. ENABLE and deliberately NOT FORCE, for
-- the reason 20260811140504477_impersonation_grants_lock_down records: FORCE
-- applies RLS to the table OWNER too, and with no policy that would deny every
-- row to the API's own database role in a deployment where it is a plain owner
-- rather than a superuser. The REVOKEs above are the control that matters.
ALTER TABLE "kortix"."session_runtime_projections" ENABLE ROW LEVEL SECURITY;
