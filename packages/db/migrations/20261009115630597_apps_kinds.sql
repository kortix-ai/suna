-- Migration: apps_kinds
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Kortix Backends become Apps of kind `convex` (expand step).
--
-- 1. `apps.kind`: a constant default, so ADD COLUMN is metadata-only (no
--    rewrite). Its CHECK is added NOT VALID and validated in the next
--    migration, so the ADD takes only a brief lock on `apps`.
-- 2. `app_convex_instances`: the machine of a `convex` App, one row per App.
--    It replaces `project_backends`; the next migrations copy the rows and drop
--    the old table. `app_links`: which App uses which, replacing the
--    `apps.backends` name list. Both tables are new and empty, so their
--    indexes lock nothing that holds rows. Their FKs to `apps` take a brief
--    SHARE ROW EXCLUSIVE lock on `apps`.
-- 3. `app_deployments`: a `convex` deployment has no artifact (the CLI deploys
--    the functions itself and records the deployment), so `artifact_id` drops
--    NOT NULL, and `source_kind` / `hosting_type` admit `convex`. Both CHECKs
--    are widened NOT VALID and validated in the next migration.
--
-- mixed-version-safe: every change only WIDENS what the database accepts.
-- Old code always writes an artifact_id, a source_kind in {static, bundle,
-- dockerfile, oci_image} and a hosting_type in {sandbox, static}, which the
-- widened constraints accept, and it never reads `kind` or the new tables.
-- Dropping and re-adding each CHECK runs in this one transaction, so no write
-- lands between the DROP and the ADD.

CREATE TABLE "kortix"."app_convex_instances" (
	"app_id" uuid PRIMARY KEY NOT NULL,
	"status" varchar(20) DEFAULT 'provisioning' NOT NULL,
	"provider" varchar(32) NOT NULL,
	"external_id" text,
	"url" text,
	"site_url" text,
	"admin_key_enc" text,
	"auth_key_enc" text,
	"auth_issuer" text,
	"template" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "app_convex_instances_status_check" CHECK ("kortix"."app_convex_instances"."status" IN ('provisioning', 'running', 'error', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."app_links" (
	"app_id" uuid NOT NULL,
	"uses_app_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_links_app_id_uses_app_id_pk" PRIMARY KEY("app_id","uses_app_id"),
	CONSTRAINT "app_links_not_self" CHECK ("kortix"."app_links"."app_id" <> "kortix"."app_links"."uses_app_id")
);
--> statement-breakpoint
ALTER TABLE "kortix"."app_convex_instances" ADD CONSTRAINT "app_convex_instances_app_id_apps_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "kortix"."apps"("app_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."app_links" ADD CONSTRAINT "app_links_app_id_apps_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "kortix"."apps"("app_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."app_links" ADD CONSTRAINT "app_links_uses_app_id_apps_app_id_fk" FOREIGN KEY ("uses_app_id") REFERENCES "kortix"."apps"("app_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_convex_instances_external_idx" ON "kortix"."app_convex_instances" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "app_links_uses_idx" ON "kortix"."app_links" USING btree ("uses_app_id");--> statement-breakpoint
ALTER TABLE "kortix"."apps" ADD COLUMN "kind" varchar(16) DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."apps" ADD CONSTRAINT "apps_kind_check" CHECK ("kortix"."apps"."kind" IN ('web', 'convex')) NOT VALID;--> statement-breakpoint
-- squawk-ignore ban-drop-not-null
ALTER TABLE "kortix"."app_deployments" ALTER COLUMN "artifact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."app_deployments" DROP CONSTRAINT "app_deployments_source_kind_check";--> statement-breakpoint
ALTER TABLE "kortix"."app_deployments" ADD CONSTRAINT "app_deployments_source_kind_check" CHECK ("kortix"."app_deployments"."source_kind" IN ('static', 'bundle', 'dockerfile', 'oci_image', 'convex')) NOT VALID;--> statement-breakpoint
ALTER TABLE "kortix"."app_deployments" DROP CONSTRAINT "app_deployments_hosting_type_check";--> statement-breakpoint
ALTER TABLE "kortix"."app_deployments" ADD CONSTRAINT "app_deployments_hosting_type_check" CHECK ("kortix"."app_deployments"."hosting_type" IN ('sandbox', 'static', 'convex')) NOT VALID;
