-- Migration: agent_rooms — rooms, room_messages, room_members (agent-to-agent rooms, flag `agent_rooms`). Three new tables only.
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

CREATE TABLE "kortix"."room_members" (
	"room_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"notify" varchar(16) DEFAULT 'all' NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_members_room_id_session_id_pk" PRIMARY KEY("room_id","session_id"),
	CONSTRAINT "room_members_notify_check" CHECK ("kortix"."room_members"."notify" in ('all', 'mentions', 'none'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."room_messages" (
	"message_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"sender_kind" varchar(16) NOT NULL,
	"sender_user_id" uuid,
	"sender_session_id" text,
	"sender_label" text NOT NULL,
	"text" text NOT NULL,
	"reply_to_seq" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_messages_sender_kind_check" CHECK ("kortix"."room_messages"."sender_kind" in ('member', 'session'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."rooms" (
	"room_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"topic" text,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_by_session_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_name_check" CHECK ("kortix"."rooms"."name" ~ '^[a-z0-9][a-z0-9._/-]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "kortix"."room_members" ADD CONSTRAINT "room_members_room_fk" FOREIGN KEY ("room_id") REFERENCES "kortix"."rooms"("room_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."room_members" ADD CONSTRAINT "room_members_session_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."room_messages" ADD CONSTRAINT "room_messages_room_fk" FOREIGN KEY ("room_id") REFERENCES "kortix"."rooms"("room_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."rooms" ADD CONSTRAINT "rooms_project_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_room_members_session" ON "kortix"."room_members" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_room_messages_room_seq" ON "kortix"."room_messages" USING btree ("room_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rooms_project_name" ON "kortix"."rooms" USING btree ("project_id","name");--> statement-breakpoint
ALTER TABLE "kortix"."rooms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."room_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."room_members" ENABLE ROW LEVEL SECURITY;
