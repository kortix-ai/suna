-- Migration: session_idle_watches — one-shot "notify me when this session goes idle" (flag agent_rooms). One new table.
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

CREATE TABLE "kortix"."session_idle_watches" (
	"watch_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_session_id" text NOT NULL,
	"room_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"watcher_kind" varchar(16) NOT NULL,
	"watcher_session_id" text,
	"watcher_user_id" uuid,
	"added_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_idle_watches_kind_check" CHECK (("kortix"."session_idle_watches"."watcher_kind" = 'session' and "kortix"."session_idle_watches"."watcher_session_id" is not null and "kortix"."session_idle_watches"."watcher_user_id" is null) or ("kortix"."session_idle_watches"."watcher_kind" = 'person' and "kortix"."session_idle_watches"."watcher_user_id" is not null and "kortix"."session_idle_watches"."watcher_session_id" is null))
);
--> statement-breakpoint
ALTER TABLE "kortix"."session_idle_watches" ADD CONSTRAINT "session_idle_watches_target_fk" FOREIGN KEY ("target_session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_idle_watches" ADD CONSTRAINT "session_idle_watches_room_fk" FOREIGN KEY ("room_id") REFERENCES "kortix"."rooms"("room_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_idle_watches" ADD CONSTRAINT "session_idle_watches_project_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_session_idle_watches_target" ON "kortix"."session_idle_watches" USING btree ("target_session_id");ALTER TABLE "kortix"."session_idle_watches" ENABLE ROW LEVEL SECURITY;
