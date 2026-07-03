-- Up Migration
--
-- Review Center: the `review_items` table + its enums. A review_item is "one
-- thing a human needs to look at or decide on" — an agent output / decision /
-- batch submitted for review, shown in a friendly per-project inbox. The
-- polymorphic `detail` jsonb carries the kind-specific payload. Mirrors the
-- Drizzle model in packages/db/src/schema/kortix.ts (reviewItems).
-- Hand-written (node-pg-migrate) because the drizzle snapshot chain forked
-- during the origin/main merge; node-pg-migrate applies migrations/*.sql
-- independently of the drizzle snapshot.

DO $$ BEGIN
 CREATE TYPE "kortix"."review_item_kind" AS ENUM ('change', 'approval', 'output', 'decision', 'batch');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 CREATE TYPE "kortix"."review_item_status" AS ENUM ('needs_you', 'waiting', 'approved', 'changes_requested', 'rejected', 'done', 'dismissed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 CREATE TYPE "kortix"."review_item_risk" AS ENUM ('none', 'low', 'medium', 'high');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 CREATE TYPE "kortix"."review_item_source" AS ENUM ('web', 'slack', 'agent');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "kortix"."review_items" (
  "review_item_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "origin_session_id" text,
  "kind" "kortix"."review_item_kind" NOT NULL,
  "status" "kortix"."review_item_status" DEFAULT 'needs_you' NOT NULL,
  "risk" "kortix"."review_item_risk" DEFAULT 'none' NOT NULL,
  "source" "kortix"."review_item_source" DEFAULT 'agent' NOT NULL,
  "title" text NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "agent" text DEFAULT '' NOT NULL,
  "created_by" uuid NOT NULL,
  "acted_by" uuid,
  "acted_at" timestamp with time zone,
  "feedback" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_items_account_id_accounts_account_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "review_items_project_id_projects_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "review_items_origin_session_id_project_sessions_session_id_fk"
    FOREIGN KEY ("origin_session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_review_items_project"
  ON "kortix"."review_items" USING btree ("project_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_review_items_project_status"
  ON "kortix"."review_items" USING btree ("project_id", "status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_review_items_project_kind"
  ON "kortix"."review_items" USING btree ("project_id", "kind");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_review_items_created"
  ON "kortix"."review_items" USING btree ("created_at");

-- Down Migration

DROP TABLE IF EXISTS "kortix"."review_items";
--> statement-breakpoint
DROP TYPE IF EXISTS "kortix"."review_item_source";
--> statement-breakpoint
DROP TYPE IF EXISTS "kortix"."review_item_risk";
--> statement-breakpoint
DROP TYPE IF EXISTS "kortix"."review_item_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "kortix"."review_item_kind";
