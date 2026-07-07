-- Up Migration
--
-- Automation Inbox: the `inbox_items` table + its kind enum. An inbox_item is a
-- per-user awareness signal that a background/triggered run did something the
-- recipient may want to see — it completing or failing while nobody watched.
-- This is an awareness feed (unread → read via `read_at`), NOT a verdict queue:
-- approvals/decisions/change-requests live in `review_items`. Generic on
-- purpose — any feature can emit here (see apps/api/src/inbox/record-attention.ts).
-- Mirrors the Drizzle model in packages/db/src/schema/kortix.ts (inboxItems).
-- Hand-written (node-pg-migrate) because the drizzle snapshot chain forked
-- during the origin/main merge; node-pg-migrate applies migrations/*.sql
-- independently of the drizzle snapshot (same as review_items).

DO $$ BEGIN
 CREATE TYPE "kortix"."inbox_item_kind" AS ENUM ('run_completed', 'run_failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "kortix"."inbox_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "session_id" text,
  "user_id" uuid NOT NULL,
  "kind" "kortix"."inbox_item_kind" NOT NULL,
  "title" text NOT NULL,
  "source" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "dedup_key" text NOT NULL,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inbox_items_account_id_accounts_account_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "inbox_items_project_id_projects_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "inbox_items_session_id_project_sessions_session_id_fk"
    FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inbox_items_user_created"
  ON "kortix"."inbox_items" USING btree ("user_id", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inbox_items_user_unread"
  ON "kortix"."inbox_items" USING btree ("user_id", "read_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inbox_items_project_user"
  ON "kortix"."inbox_items" USING btree ("project_id", "user_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inbox_items_session"
  ON "kortix"."inbox_items" USING btree ("session_id");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_inbox_items_dedup"
  ON "kortix"."inbox_items" USING btree ("user_id", "dedup_key");

-- Down Migration

DROP TABLE IF EXISTS "kortix"."inbox_items";
--> statement-breakpoint
DROP TYPE IF EXISTS "kortix"."inbox_item_kind";
