-- Migration: add_kortix_apps
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

CREATE TABLE "kortix"."app_artifacts" (
	"artifact_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'uploading' NOT NULL,
	"object_path" text,
	"image_reference" text,
	"sha256" varchar(64),
	"size_bytes" bigint,
	"media_type" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_artifacts_object_path_unique" UNIQUE("object_path"),
	CONSTRAINT "app_artifacts_kind_check" CHECK ("kortix"."app_artifacts"."kind" IN ('archive', 'oci_image')),
	CONSTRAINT "app_artifacts_status_check" CHECK ("kortix"."app_artifacts"."status" IN ('uploading', 'uploaded', 'ready', 'rejected', 'deleted')),
	CONSTRAINT "app_artifacts_size_check" CHECK ("kortix"."app_artifacts"."size_bytes" IS NULL OR "kortix"."app_artifacts"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "kortix"."app_deployment_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"runtime_id" uuid,
	"level" varchar(8) DEFAULT 'info' NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_deployment_events_level_check" CHECK ("kortix"."app_deployment_events"."level" IN ('debug', 'info', 'warn', 'error'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."app_deployments" (
	"deployment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"source_kind" varchar(16) NOT NULL,
	"hosting_type" varchar(16) DEFAULT 'sandbox' NOT NULL,
	"hosting_provider" varchar(32),
	"provider_build_id" text,
	"runtime_spec" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"build_spec" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runtime_version" text NOT NULL,
	"error_code" text,
	"error" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_deployments_status_check" CHECK ("kortix"."app_deployments"."status" IN ('queued', 'validating', 'building', 'provisioning', 'checking', 'ready', 'failed', 'cancelled')),
	CONSTRAINT "app_deployments_source_kind_check" CHECK ("kortix"."app_deployments"."source_kind" IN ('static', 'bundle', 'dockerfile', 'oci_image')),
	CONSTRAINT "app_deployments_hosting_type_check" CHECK ("kortix"."app_deployments"."hosting_type" = 'sandbox'),
	CONSTRAINT "app_deployments_version_check" CHECK ("kortix"."app_deployments"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "kortix"."app_runtimes" (
	"runtime_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"external_id" text NOT NULL,
	"status" varchar(20) DEFAULT 'provisioning' NOT NULL,
	"control_port" integer DEFAULT 7331 NOT NULL,
	"ingress_port" integer DEFAULT 8080 NOT NULL,
	"control_token_hash" text NOT NULL,
	"idle_deadline_at" timestamp with time zone,
	"activity_lease_until" timestamp with time zone,
	"wake_lease_owner" text,
	"wake_lease_until" timestamp with time zone,
	"last_request_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "app_runtimes_status_check" CHECK ("kortix"."app_runtimes"."status" IN ('provisioning', 'starting', 'running', 'stopping', 'stopped', 'error', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."apps" (
	"app_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" varchar(63) NOT NULL,
	"name" text NOT NULL,
	"route_key" varchar(20) NOT NULL,
	"desired_state" varchar(16) DEFAULT 'running' NOT NULL,
	"active_deployment_id" uuid,
	"cpu_cores" integer DEFAULT 1 NOT NULL,
	"memory_gb" integer DEFAULT 2 NOT NULL,
	"disk_gb" integer DEFAULT 10 NOT NULL,
	"idle_timeout_seconds" integer DEFAULT 300 NOT NULL,
	"monthly_budget_usd" numeric(12, 2) DEFAULT '5.00' NOT NULL,
	"last_request_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "apps_route_key_unique" UNIQUE("route_key"),
	CONSTRAINT "apps_desired_state_check" CHECK ("kortix"."apps"."desired_state" IN ('running', 'stopped')),
	CONSTRAINT "apps_cpu_check" CHECK ("kortix"."apps"."cpu_cores" BETWEEN 1 AND 64),
	CONSTRAINT "apps_memory_check" CHECK ("kortix"."apps"."memory_gb" BETWEEN 1 AND 512),
	CONSTRAINT "apps_disk_check" CHECK ("kortix"."apps"."disk_gb" BETWEEN 1 AND 2048),
	CONSTRAINT "apps_idle_timeout_check" CHECK ("kortix"."apps"."idle_timeout_seconds" BETWEEN 120 AND 86400),
	CONSTRAINT "apps_budget_check" CHECK ("kortix"."apps"."monthly_budget_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "kortix"."sandbox_compute_sessions" ADD COLUMN "workload_type" varchar(16) DEFAULT 'session' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."sandbox_compute_sessions" ADD COLUMN "app_runtime_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."app_artifacts" ADD CONSTRAINT "app_artifacts_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."app_deployment_events" ADD CONSTRAINT "app_deployment_events_runtime_id_app_runtimes_runtime_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "kortix"."app_runtimes"("runtime_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."app_deployment_events" ADD CONSTRAINT "app_deployment_events_deployment_fk" FOREIGN KEY ("deployment_id") REFERENCES "kortix"."app_deployments"("deployment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."app_deployments" ADD CONSTRAINT "app_deployments_app_id_apps_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "kortix"."apps"("app_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."app_deployments" ADD CONSTRAINT "app_deployments_artifact_id_app_artifacts_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "kortix"."app_artifacts"("artifact_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."app_runtimes" ADD CONSTRAINT "app_runtimes_deployment_id_app_deployments_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "kortix"."app_deployments"("deployment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."apps" ADD CONSTRAINT "apps_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."apps" ADD CONSTRAINT "apps_active_deployment_fk" FOREIGN KEY ("active_deployment_id") REFERENCES "kortix"."app_deployments"("deployment_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Existing compute rows have a NULL app_runtime_id. NOT VALID prevents this
-- additive release from scanning the live compute ledger while holding the
-- schema lock. The companion validation migration checks it online.
ALTER TABLE "kortix"."sandbox_compute_sessions" ADD CONSTRAINT "sandbox_compute_sessions_app_runtime_fk" FOREIGN KEY ("app_runtime_id") REFERENCES "kortix"."app_runtimes"("runtime_id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "app_artifacts_project_idx" ON "kortix"."app_artifacts" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "app_artifacts_sha_idx" ON "kortix"."app_artifacts" USING btree ("account_id","sha256");--> statement-breakpoint
CREATE INDEX "app_deployment_events_deployment_idx" ON "kortix"."app_deployment_events" USING btree ("deployment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "app_deployments_app_version_unique" ON "kortix"."app_deployments" USING btree ("app_id","version");--> statement-breakpoint
CREATE INDEX "app_deployments_queue_idx" ON "kortix"."app_deployments" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "app_deployments_app_idx" ON "kortix"."app_deployments" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE INDEX "app_runtimes_deployment_idx" ON "kortix"."app_runtimes" USING btree ("deployment_id","created_at");--> statement-breakpoint
CREATE INDEX "app_runtimes_external_idx" ON "kortix"."app_runtimes" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_runtimes_one_live_per_deployment" ON "kortix"."app_runtimes" USING btree ("deployment_id") WHERE "kortix"."app_runtimes"."status" IN ('provisioning', 'starting', 'running', 'stopping');--> statement-breakpoint
CREATE UNIQUE INDEX "apps_project_slug_live_unique" ON "kortix"."apps" USING btree ("project_id","slug") WHERE "kortix"."apps"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "apps_account_idx" ON "kortix"."apps" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "apps_route_key_idx" ON "kortix"."apps" USING btree ("route_key");--> statement-breakpoint
ALTER TABLE "kortix"."sandbox_compute_sessions" ADD CONSTRAINT "sandbox_compute_sessions_workload_type_check" CHECK ("kortix"."sandbox_compute_sessions"."workload_type" IN ('session', 'app')) NOT VALID;
