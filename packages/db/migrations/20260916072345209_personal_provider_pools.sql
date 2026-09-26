-- Migration: personal_provider_pools
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

CREATE TABLE "kortix"."session_user_provider_connections" (
	"session_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" varchar(128) NOT NULL,
	"connection_id" uuid NOT NULL,
	-- squawk-ignore identifier-too-long
	CONSTRAINT "session_user_provider_connections_session_id_user_id_provider_id_pk" PRIMARY KEY("session_id","user_id","provider_id")
);
--> statement-breakpoint
ALTER TABLE "kortix"."user_provider_connections" ADD COLUMN "slot" varchar(64) DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."user_provider_connections" ADD COLUMN "label" varchar(100) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."project_user_provider_connections" ADD COLUMN "pool" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- squawk-ignore identifier-too-long
ALTER TABLE "kortix"."session_user_provider_connections" ADD CONSTRAINT "session_user_provider_connections_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_user_provider_connections" ADD CONSTRAINT "session_user_provider_connections_owner_fk" FOREIGN KEY ("connection_id","user_id","provider_id") REFERENCES "kortix"."user_provider_connections"("connection_id","user_id","provider_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_user_provider_connections_connection" ON "kortix"."session_user_provider_connections" USING btree ("connection_id");--> statement-breakpoint

ALTER TABLE kortix.session_user_provider_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON kortix.session_user_provider_connections FROM anon, authenticated;
