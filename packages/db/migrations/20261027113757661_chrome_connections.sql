-- Migration: chrome_connections
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

CREATE TABLE "kortix"."chrome_attachments" (
	"attachment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chrome_id" uuid NOT NULL,
	"user_id" uuid,
	"project_id" text,
	"session_id" text NOT NULL,
	"status" text NOT NULL,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chrome_attachments_status" CHECK ("kortix"."chrome_attachments"."status" in ('pending', 'granted', 'connected', 'denied', 'ended', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."chrome_connections" (
	"chrome_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"brand" text NOT NULL,
	"os" text NOT NULL,
	"profile_label" text,
	"extension_version" text,
	"access_mode" text DEFAULT 'always' NOT NULL,
	"tab_scope" text DEFAULT 'all' NOT NULL,
	"relay_owner_id" text,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chrome_connections_access_mode" CHECK ("kortix"."chrome_connections"."access_mode" in ('always', 'ask', 'off')),
	CONSTRAINT "chrome_connections_tab_scope" CHECK ("kortix"."chrome_connections"."tab_scope" in ('own', 'all'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."chrome_grants" (
	"grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chrome_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"session_id" text,
	"decision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chrome_grants_decision" CHECK ("kortix"."chrome_grants"."decision" in ('allow', 'deny'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."chrome_attachments" ADD CONSTRAINT "chrome_attachments_chrome_fk" FOREIGN KEY ("chrome_id") REFERENCES "kortix"."chrome_connections"("chrome_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."chrome_grants" ADD CONSTRAINT "chrome_grants_chrome_fk" FOREIGN KEY ("chrome_id") REFERENCES "kortix"."chrome_connections"("chrome_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chrome_attachments_chrome" ON "kortix"."chrome_attachments" USING btree ("chrome_id","status");--> statement-breakpoint
CREATE INDEX "idx_chrome_attachments_session" ON "kortix"."chrome_attachments" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_chrome_connections_user" ON "kortix"."chrome_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_chrome_grants_chrome" ON "kortix"."chrome_grants" USING btree ("chrome_id","session_id");--> statement-breakpoint

-- Take the three tables OUT of the schema-wide default grants. The kortix
-- schema grants `anon` SELECT and `authenticated` SELECT/INSERT/UPDATE on every
-- new table, and PostgREST exposes the schema. These tables name a person's
-- browsers and the sessions that used them. `postgres` and `service_role` keep
-- full access; the API connects as one of them.
REVOKE ALL ON TABLE "kortix"."chrome_connections" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."chrome_connections" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."chrome_grants" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."chrome_grants" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."chrome_attachments" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."chrome_attachments" FROM authenticated;--> statement-breakpoint

-- ENABLE, not FORCE, as in 20260826064400234_session_transcript_mirror.sql:
-- with no policy, a non-owner role sees no rows; the owner (the API) is
-- unaffected.
ALTER TABLE "kortix"."chrome_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."chrome_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."chrome_attachments" ENABLE ROW LEVEL SECURITY;
