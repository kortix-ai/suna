-- Migration: browser_connections
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

CREATE TABLE "kortix"."browser_attachments" (
	"attachment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"browser_id" uuid NOT NULL,
	"user_id" uuid,
	"project_id" text,
	"session_id" text NOT NULL,
	"status" text NOT NULL,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_attachments_status" CHECK ("kortix"."browser_attachments"."status" in ('pending', 'granted', 'connected', 'denied', 'ended', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."browser_connections" (
	"browser_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
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
	CONSTRAINT "browser_connections_access_mode" CHECK ("kortix"."browser_connections"."access_mode" in ('always', 'ask', 'off')),
	CONSTRAINT "browser_connections_tab_scope" CHECK ("kortix"."browser_connections"."tab_scope" in ('own', 'all'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."browser_grants" (
	"grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"browser_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"session_id" text,
	"decision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_grants_decision" CHECK ("kortix"."browser_grants"."decision" in ('allow', 'deny'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."browser_attachments" ADD CONSTRAINT "browser_attachments_browser_fk" FOREIGN KEY ("browser_id") REFERENCES "kortix"."browser_connections"("browser_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."browser_grants" ADD CONSTRAINT "browser_grants_browser_fk" FOREIGN KEY ("browser_id") REFERENCES "kortix"."browser_connections"("browser_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_browser_attachments_browser" ON "kortix"."browser_attachments" USING btree ("browser_id","status");--> statement-breakpoint
CREATE INDEX "idx_browser_attachments_session" ON "kortix"."browser_attachments" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_browser_connections_user" ON "kortix"."browser_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_browser_grants_browser" ON "kortix"."browser_grants" USING btree ("browser_id","session_id");--> statement-breakpoint

-- Take the three tables OUT of the schema-wide default grants. The kortix
-- schema grants `anon` SELECT and `authenticated` SELECT/INSERT/UPDATE on every
-- new table, and PostgREST exposes the schema. These tables name a person's
-- browsers and the sessions that used them. `postgres` and `service_role` keep
-- full access; the API connects as one of them.
REVOKE ALL ON TABLE "kortix"."browser_connections" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."browser_connections" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."browser_grants" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."browser_grants" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."browser_attachments" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."browser_attachments" FROM authenticated;--> statement-breakpoint

-- ENABLE, not FORCE, as in 20260826064400234_session_transcript_mirror.sql:
-- with no policy, a non-owner role sees no rows; the owner (the API) is
-- unaffected.
ALTER TABLE "kortix"."browser_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."browser_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."browser_attachments" ENABLE ROW LEVEL SECURITY;
