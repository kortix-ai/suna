-- Migration: multi_agent_messages_tasks
--
-- Cross-session messages (session_peer_messages: the record, the hold and the
-- notify_when_idle watch) and the agent-team task list (session_tasks, flag
-- agent_teams). Two new tables; no existing table changes.
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
--   [ ] Any ALTER TYPE ... ADD VALUE needs: (none here)

CREATE TABLE "kortix"."session_peer_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"from_session_id" text NOT NULL,
	"from_handle" text NOT NULL,
	"to_session_id" text NOT NULL,
	"to_handle" text NOT NULL,
	"type" varchar(24) NOT NULL,
	"message" text NOT NULL,
	"summary" text,
	"status" varchar(16) NOT NULL,
	"notify_when_idle" boolean DEFAULT false NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"idle_notice_until" timestamp with time zone,
	CONSTRAINT "session_peer_messages_type_check" CHECK ("kortix"."session_peer_messages"."type" in ('message', 'shutdown_request', 'shutdown_response')),
	CONSTRAINT "session_peer_messages_status_check" CHECK ("kortix"."session_peer_messages"."status" in ('delivered', 'held', 'refused', 'denied', 'expired', 'dropped'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."session_peer_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kortix"."session_tasks" (
	"task_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"lead_session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"subject" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"owner_handle" text,
	"owner_session_id" text,
	"blocked_by" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"created_by_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_tasks_lead_seq_key" UNIQUE("lead_session_id","seq"),
	CONSTRAINT "session_tasks_status_check" CHECK ("kortix"."session_tasks"."status" in ('pending', 'in_progress', 'completed')),
	CONSTRAINT "session_tasks_seq_check" CHECK ("kortix"."session_tasks"."seq" > 0)
);
--> statement-breakpoint
ALTER TABLE "kortix"."session_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."session_peer_messages" ADD CONSTRAINT "session_peer_messages_project_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_peer_messages" ADD CONSTRAINT "session_peer_messages_from_fk" FOREIGN KEY ("from_session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_peer_messages" ADD CONSTRAINT "session_peer_messages_to_fk" FOREIGN KEY ("to_session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_tasks" ADD CONSTRAINT "session_tasks_project_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_tasks" ADD CONSTRAINT "session_tasks_lead_fk" FOREIGN KEY ("lead_session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_session_peer_messages_from" ON "kortix"."session_peer_messages" USING btree ("from_session_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_session_peer_messages_to" ON "kortix"."session_peer_messages" USING btree ("to_session_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_session_peer_messages_held" ON "kortix"."session_peer_messages" USING btree ("to_session_id","expires_at") WHERE "kortix"."session_peer_messages"."status" = 'held';--> statement-breakpoint
CREATE INDEX "idx_session_peer_messages_idle_due" ON "kortix"."session_peer_messages" USING btree ("to_session_id") WHERE "kortix"."session_peer_messages"."idle_notice_until" is not null;--> statement-breakpoint
CREATE INDEX "idx_session_tasks_owner" ON "kortix"."session_tasks" USING btree ("owner_session_id") WHERE "kortix"."session_tasks"."owner_session_id" is not null;