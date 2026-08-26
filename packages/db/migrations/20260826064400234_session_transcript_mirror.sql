-- Migration: session_transcript_mirror
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEWED. Two edits to what drizzle-kit generated from the diff:
--
--  1. DELETED `ALTER TYPE "kortix"."connector_provider" ADD VALUE 'composio'`.
--     It is proposed from a stale snapshot and is already applied by
--     20260824150000000_connector_connections_composio_metadata_index's
--     predecessor; re-issuing it here would put an unrelated ALTER TYPE ... ADD
--     VALUE inside this migration for no reason.
--  2. ADDED the grant lock-down at the bottom. The `kortix` schema carries
--     standing default privileges from the baseline
--     (20260621094136410_baseline.sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA
--     kortix GRANT SELECT, INSERT, UPDATE ON TABLES TO authenticated` / `GRANT
--     SELECT ... TO anon`) and supabase/config.toml exposes the schema through
--     PostgREST, so a table created here is born readable by `anon`. These two
--     tables hold the literal TEXT of user prompts and agent replies. Same
--     treatment as 20260817200334007_session_turns.
--
-- Both tables are NEW, so every index and foreign key below is created on an
-- empty relation: no CONCURRENTLY needed, no lock held over live rows, no
-- backfill DML anywhere in this file.

CREATE TABLE "kortix"."session_transcript_messages" (
	"session_id" text NOT NULL,
	"message_id" text NOT NULL,
	"parent_message_id" text,
	"opencode_session_id" text,
	"role" text NOT NULL,
	"message_created_at" timestamp with time zone,
	"message_completed_at" timestamp with time zone,
	"info" jsonb NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_transcript_messages_pkey" PRIMARY KEY("session_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "kortix"."session_transcript_mirrors" (
	"session_id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"opencode_session_id" text,
	"head_complete" boolean DEFAULT false NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."session_transcript_messages" ADD CONSTRAINT "session_transcript_messages_mirror_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."session_transcript_mirrors"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_transcript_mirrors" ADD CONSTRAINT "session_transcript_mirrors_session_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_transcript_messages_order_idx" ON "kortix"."session_transcript_messages" USING btree ("session_id","message_created_at","message_id");--> statement-breakpoint
CREATE INDEX "session_transcript_mirrors_project_idx" ON "kortix"."session_transcript_mirrors" USING btree ("project_id");--> statement-breakpoint

-- Take both tables OUT of the schema-wide default grants (see the header). An
-- anon-key GET against `/rest/v1/session_transcript_messages` with
-- `Accept-Profile: kortix` would otherwise return every mirrored prompt and
-- reply in the database. `postgres` and `service_role` keep full access -- the
-- API connects as one of them; every browser-reachable role gets nothing.
REVOKE ALL ON TABLE "kortix"."session_transcript_mirrors" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."session_transcript_mirrors" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."session_transcript_messages" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."session_transcript_messages" FROM authenticated;--> statement-breakpoint

-- Belt and braces: if a future blanket `GRANT ... ON ALL TABLES IN SCHEMA
-- kortix` re-adds the privilege, RLS with no policy still denies every row to
-- every non-superuser, non-owner role. ENABLE and deliberately NOT FORCE, for
-- the reason 20260811140504477_impersonation_grants_lock_down records: FORCE
-- applies RLS to the table OWNER too, and with no policy that would deny every
-- row to the API's own database role in a deployment where it is a plain owner
-- rather than a superuser. The REVOKEs above are the control that matters.
ALTER TABLE "kortix"."session_transcript_mirrors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."session_transcript_messages" ENABLE ROW LEVEL SECURITY;
