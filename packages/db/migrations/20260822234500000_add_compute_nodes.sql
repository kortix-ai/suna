-- Migration: add_compute_nodes
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

CREATE TABLE "kortix"."compute_node_assignments" (
	"assignment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"status" text DEFAULT 'assigned' NOT NULL,
	"lease_epoch" integer DEFAULT 1 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compute_node_assignments_status_check" CHECK ("kortix"."compute_node_assignments"."status" IN ('assigned', 'ready', 'draining', 'released', 'failed')),
	CONSTRAINT "compute_node_assignments_lease_epoch_check" CHECK ("kortix"."compute_node_assignments"."lease_epoch" > 0)
);
--> statement-breakpoint
CREATE TABLE "kortix"."compute_nodes" (
	"node_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid,
	"type" text DEFAULT 'sandbox' NOT NULL,
	"provider" text,
	"allocation_id" text,
	"architecture" text,
	"operating_system" text,
	"daemon_version" text,
	"update_channel" text DEFAULT 'stable' NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"harnesses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"concurrency" integer DEFAULT 1 NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"desired_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compute_nodes_type_check" CHECK ("kortix"."compute_nodes"."type" IN ('sandbox', 'workstation', 'vm', 'container', 'bare_metal', 'ci')),
	CONSTRAINT "compute_nodes_status_check" CHECK ("kortix"."compute_nodes"."status" IN ('provisioning', 'online', 'offline', 'disabled', 'draining', 'error', 'deleted')),
	CONSTRAINT "compute_nodes_concurrency_check" CHECK ("kortix"."compute_nodes"."concurrency" > 0 AND "kortix"."compute_nodes"."concurrency" <= 1024)
);
--> statement-breakpoint
ALTER TABLE "kortix"."compute_node_assignments" ADD CONSTRAINT "compute_node_assignments_node_id_compute_nodes_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "kortix"."compute_nodes"("node_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."compute_node_assignments" ADD CONSTRAINT "compute_node_assignments_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."compute_node_assignments" ADD CONSTRAINT "compute_node_assignments_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."compute_nodes" ADD CONSTRAINT "compute_nodes_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."compute_nodes" ADD CONSTRAINT "compute_nodes_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compute_node_assignments_node_session_unique" ON "kortix"."compute_node_assignments" USING btree ("node_id","session_id");--> statement-breakpoint
CREATE INDEX "compute_node_assignments_node_idx" ON "kortix"."compute_node_assignments" USING btree ("node_id","status");--> statement-breakpoint
CREATE INDEX "compute_node_assignments_session_idx" ON "kortix"."compute_node_assignments" USING btree ("session_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "compute_nodes_allocation_unique" ON "kortix"."compute_nodes" USING btree ("provider","allocation_id");--> statement-breakpoint
CREATE INDEX "compute_nodes_account_idx" ON "kortix"."compute_nodes" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "compute_nodes_project_idx" ON "kortix"."compute_nodes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "compute_nodes_status_idx" ON "kortix"."compute_nodes" USING btree ("status");
