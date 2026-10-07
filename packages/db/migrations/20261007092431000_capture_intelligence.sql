-- Migration: capture_intelligence
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHAT: Capture Intelligence (L1 episodes, L2 steps, L3 workflows, bulk
-- exports, daily model spend). Every table is NEW and empty; the FKs reference
-- kortix.accounts and kortix.capture_devices / capture_episodes, both created
-- by *_capture_timeline (no scan: the new tables are empty).
--
-- HAND EDITS: client roles revoked and RLS on (the API alone reads these).
--
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

CREATE TABLE "kortix"."capture_ai_usage" (
	"account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "capture_ai_usage_pkey" PRIMARY KEY("account_id","day")
);
--> statement-breakpoint
CREATE TABLE "kortix"."capture_episode_steps" (
	"step_id" uuid PRIMARY KEY DEFAULT kortix.uuid_v7() NOT NULL,
	"episode_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"verb" text NOT NULL,
	"app" text,
	"object" text NOT NULL,
	"params" text,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"keyframe_frame_id" uuid,
	"action_id" uuid
);
--> statement-breakpoint
CREATE TABLE "kortix"."capture_episodes" (
	"episode_id" uuid PRIMARY KEY DEFAULT kortix.uuid_v7() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"source" text DEFAULT 'detected' NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"label" text,
	"goal" text,
	"outcome" text,
	"outcome_status" text,
	"apps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"steps_count" integer DEFAULT 0 NOT NULL,
	"signature" text,
	"workflow_id" uuid,
	"variant_key" text,
	"model" text,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_episodes_source" CHECK ("kortix"."capture_episodes"."source" in ('detected', 'saved')),
	CONSTRAINT "capture_episodes_status" CHECK ("kortix"."capture_episodes"."status" in ('open', 'closed', 'traced', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."capture_exports" (
	"export_id" uuid PRIMARY KEY DEFAULT kortix.uuid_v7() NOT NULL,
	"account_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"format" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"object_key" text,
	"rows" integer,
	"bytes" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_exports_format" CHECK ("kortix"."capture_exports"."format" in ('jsonl', 'parquet')),
	CONSTRAINT "capture_exports_status" CHECK ("kortix"."capture_exports"."status" in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."capture_workflows" (
	"workflow_id" uuid PRIMARY KEY DEFAULT kortix.uuid_v7() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"goal" text,
	"outcome" text,
	"status" text DEFAULT 'detected' NOT NULL,
	"signature" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"apps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"runs_total" integer DEFAULT 0 NOT NULL,
	"runs_per_week" numeric(10, 2) DEFAULT '0' NOT NULL,
	"duration_p50_s" integer DEFAULT 0 NOT NULL,
	"duration_p90_s" integer DEFAULT 0 NOT NULL,
	"people_count" integer DEFAULT 0 NOT NULL,
	"success_rate" numeric(5, 4),
	"determinism" numeric(5, 4) DEFAULT '0' NOT NULL,
	"automation_hours_per_week" numeric(10, 2) DEFAULT '0' NOT NULL,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"skill" jsonb,
	"model" text,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_workflows_status" CHECK ("kortix"."capture_workflows"."status" in ('detected', 'reviewed', 'exported'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."capture_ai_usage" ADD CONSTRAINT "capture_ai_usage_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."capture_episode_steps" ADD CONSTRAINT "capture_episode_steps_episode_id_capture_episodes_episode_id_fk" FOREIGN KEY ("episode_id") REFERENCES "kortix"."capture_episodes"("episode_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."capture_episodes" ADD CONSTRAINT "capture_episodes_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."capture_episodes" ADD CONSTRAINT "capture_episodes_device_id_capture_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "kortix"."capture_devices"("device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."capture_exports" ADD CONSTRAINT "capture_exports_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."capture_workflows" ADD CONSTRAINT "capture_workflows_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_capture_episode_steps_order" ON "kortix"."capture_episode_steps" USING btree ("episode_id","index");--> statement-breakpoint
CREATE INDEX "idx_capture_episodes_account_user_start" ON "kortix"."capture_episodes" USING btree ("account_id","user_id","start_at");--> statement-breakpoint
CREATE INDEX "idx_capture_episodes_account_workflow" ON "kortix"."capture_episodes" USING btree ("account_id","workflow_id");--> statement-breakpoint
CREATE INDEX "idx_capture_episodes_device_start" ON "kortix"."capture_episodes" USING btree ("device_id","start_at");--> statement-breakpoint
CREATE INDEX "idx_capture_exports_account" ON "kortix"."capture_exports" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_capture_workflows_account_score" ON "kortix"."capture_workflows" USING btree ("account_id","automation_hours_per_week");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_capture_workflows_account_signature" ON "kortix"."capture_workflows" USING btree ("account_id","signature");
--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."capture_episodes", "kortix"."capture_episode_steps", "kortix"."capture_workflows",
  "kortix"."capture_exports", "kortix"."capture_ai_usage" FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE "kortix"."capture_episodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."capture_episode_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."capture_workflows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."capture_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."capture_ai_usage" ENABLE ROW LEVEL SECURITY;
