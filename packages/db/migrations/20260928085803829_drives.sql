-- Migration: drives
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Two new, empty, server-only tables: nothing reads them before this deploys,
-- so the plain CREATE INDEX statements below block no traffic.

CREATE TABLE "kortix"."drives" (
	"drive_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid,
	"project_id" uuid,
	"agent_name" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"platinum_volume_id" text,
	"platinum_volume_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drives_platinum_volume_name_key" UNIQUE("platinum_volume_name"),
	CONSTRAINT "drives_kind" CHECK ("kortix"."drives"."kind" in ('personal', 'agent', 'company'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."drive_grants" (
	"drive_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"access" text DEFAULT 'write' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_grants_drive_id_project_id_pk" PRIMARY KEY("drive_id","project_id"),
	CONSTRAINT "drive_grants_access" CHECK ("kortix"."drive_grants"."access" in ('read', 'write'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."drives" ADD CONSTRAINT "drives_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."drives" ADD CONSTRAINT "drives_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."drive_grants" ADD CONSTRAINT "drive_grants_drive_id_drives_drive_id_fk" FOREIGN KEY ("drive_id") REFERENCES "kortix"."drives"("drive_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."drive_grants" ADD CONSTRAINT "drive_grants_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_drives_account" ON "kortix"."drives" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_drives_project" ON "kortix"."drives" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drives_default_personal" ON "kortix"."drives" USING btree ("account_id","owner_user_id") WHERE "kortix"."drives"."kind" = 'personal' and "kortix"."drives"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "drives_agent_per_project" ON "kortix"."drives" USING btree ("project_id","agent_name") WHERE "kortix"."drives"."kind" = 'agent';--> statement-breakpoint
CREATE INDEX "idx_drive_grants_project" ON "kortix"."drive_grants" USING btree ("project_id");
ALTER TABLE kortix.drives ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON kortix.drives FROM anon, authenticated;
ALTER TABLE kortix.drive_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON kortix.drive_grants FROM anon, authenticated;
