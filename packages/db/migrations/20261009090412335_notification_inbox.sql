-- Migration: notification_inbox
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

CREATE TABLE "kortix"."notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."notification_watchers" (
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_watchers_session_id_user_id_pk" PRIMARY KEY("session_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "kortix"."notifications" (
	"notification_id" uuid PRIMARY KEY DEFAULT kortix.uuid_v7() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid,
	"session_id" text,
	"trigger_slug" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"actor_user_id" uuid,
	"dedupe_key" text,
	"read_at" timestamp with time zone,
	"email_due_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_user_dedupe" UNIQUE("user_id","dedupe_key"),
	CONSTRAINT "notifications_kind" CHECK ("kortix"."notifications"."kind" IN ('turn_done', 'turn_error', 'question', 'permission', 'shared', 'automation_failed', 'automation_recovered'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."trigger_watchers" (
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"user_id" uuid NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trigger_watchers_project_id_slug_user_id_pk" PRIMARY KEY("project_id","slug","user_id")
);
--> statement-breakpoint
CREATE TABLE "kortix"."web_push_subscriptions" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"auth_session_id" uuid NOT NULL,
	"aal" varchar(8) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "alert_failing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "alert_source" varchar(8);--> statement-breakpoint
ALTER TABLE "kortix"."session_presence_leases" ADD COLUMN "alerts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."notification_watchers" ADD CONSTRAINT "notification_watchers_project_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."notifications" ADD CONSTRAINT "notifications_account_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."notifications" ADD CONSTRAINT "notifications_project_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."trigger_watchers" ADD CONSTRAINT "trigger_watchers_project_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notification_watchers_user" ON "kortix"."notification_watchers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_notification_watchers_project" ON "kortix"."notification_watchers" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_id" ON "kortix"."notifications" USING btree ("user_id","notification_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_notifications_user_unread" ON "kortix"."notifications" USING btree ("user_id") WHERE "kortix"."notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_notifications_email_due" ON "kortix"."notifications" USING btree ("email_due_at") WHERE "kortix"."notifications"."emailed_at" IS NULL AND "kortix"."notifications"."email_due_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_notifications_digested" ON "kortix"."notifications" USING btree ("emailed_at","user_id") WHERE "kortix"."notifications"."email_due_at" IS NOT NULL AND "kortix"."notifications"."emailed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_notifications_account" ON "kortix"."notifications" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_project" ON "kortix"."notifications" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_created" ON "kortix"."notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_trigger_watchers_user" ON "kortix"."trigger_watchers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_web_push_subscriptions_user" ON "kortix"."web_push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_web_push_subscriptions_auth_session" ON "kortix"."web_push_subscriptions" USING btree ("auth_session_id");--> statement-breakpoint
ALTER TABLE "kortix"."notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."notification_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."notification_watchers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."trigger_watchers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."web_push_subscriptions" ENABLE ROW LEVEL SECURITY;
