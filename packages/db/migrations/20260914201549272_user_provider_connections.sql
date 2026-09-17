-- Migration: user_provider_connections
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

-- PostgreSQL deterministically truncates this generated constraint name; no code addresses it by name.
-- squawk-ignore identifier-too-long
CREATE TABLE "kortix"."project_user_provider_connections" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" varchar(128) NOT NULL,
	"connection_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- squawk-ignore identifier-too-long
	CONSTRAINT "project_user_provider_connections_project_id_user_id_provider_id_pk" PRIMARY KEY("project_id","user_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "kortix"."user_provider_connections" (
	"connection_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" varchar(128) NOT NULL,
	"auth_type" varchar(32) NOT NULL,
	"value_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_provider_connections_owner_identity" UNIQUE("connection_id","user_id","provider_id"),
	CONSTRAINT "user_provider_connections_auth_type" CHECK ("kortix"."user_provider_connections"."auth_type" in ('api_key', 'device_oauth'))
);
--> statement-breakpoint
-- PostgreSQL deterministically truncates this generated constraint name; no code addresses it by name.
-- squawk-ignore identifier-too-long
ALTER TABLE "kortix"."project_user_provider_connections" ADD CONSTRAINT "project_user_provider_connections_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_user_provider_connections" ADD CONSTRAINT "project_user_provider_connections_owner_fk" FOREIGN KEY ("connection_id","user_id","provider_id") REFERENCES "kortix"."user_provider_connections"("connection_id","user_id","provider_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_user_provider_connections_connection" ON "kortix"."project_user_provider_connections" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_provider_connections_user_provider" ON "kortix"."user_provider_connections" USING btree ("user_id","provider_id");

-- API-only credential tables. Authenticated PostgREST roles must never read ciphertext.
ALTER TABLE kortix.user_provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE kortix.project_user_provider_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON kortix.user_provider_connections FROM anon, authenticated;
REVOKE ALL ON kortix.project_user_provider_connections FROM anon, authenticated;
ALTER TABLE kortix.user_provider_connections ADD CONSTRAINT user_provider_connections_user_fk
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
