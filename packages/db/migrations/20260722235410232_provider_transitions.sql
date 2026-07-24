-- Migration: provider_transitions
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Purely additive: a brand-new type + table, plus one new column on `projects`
-- added WITH a default (no table rewrite, no lock beyond a fast catalog update on
-- modern Postgres). No existing object is dropped, renamed, retyped, or has a
-- value added to an existing enum, so no mixed-version-safe / enum-value-checked
-- annotation is required. Old code ignores the new column + table; new code
-- treats a 0 generation / absent transition as "no migration in flight".
CREATE TYPE "kortix"."provider_transition_status" AS ENUM('pending', 'building', 'ready', 'activating', 'activated', 'failed', 'superseded', 'cancelled');--> statement-breakpoint
CREATE TABLE "kortix"."provider_transitions" (
	"transition_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_provider" "kortix"."sandbox_provider" NOT NULL,
	"target_provider" "kortix"."sandbox_provider" NOT NULL,
	"generation" integer,
	"mode" varchar(16) DEFAULT 'switch' NOT NULL,
	"status" "kortix"."provider_transition_status" DEFAULT 'pending' NOT NULL,
	"commit_sha" text,
	"base_runtime_identity" text,
	"snapshot_name" text,
	"external_template_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"error_class" varchar(32),
	"next_retry_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_provider_transitions_project_generation" UNIQUE("project_id","generation")
);
--> statement-breakpoint
ALTER TABLE "kortix"."projects" ADD COLUMN "sandbox_provider_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."provider_transitions" ADD CONSTRAINT "provider_transitions_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."provider_transitions" ADD CONSTRAINT "provider_transitions_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_provider_transitions_project_recent" ON "kortix"."provider_transitions" USING btree ("project_id","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_provider_transitions_status" ON "kortix"."provider_transitions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_provider_transitions_resume" ON "kortix"."provider_transitions" USING btree ("status","next_retry_at","heartbeat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_provider_transitions_live_identity" ON "kortix"."provider_transitions" USING btree ("project_id","target_provider","commit_sha","base_runtime_identity") WHERE status in ('pending','building','ready','activating');