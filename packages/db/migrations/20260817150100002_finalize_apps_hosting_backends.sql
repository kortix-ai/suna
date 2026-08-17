-- Migration: finalize_apps_hosting_backends
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The validated check lets PostgreSQL prove this without scanning the table.
-- mixed-version-safe: the column default keeps old INSERT statements valid.
ALTER TABLE "kortix"."app_runtimes"
  -- squawk-ignore adding-not-nullable-field
  ALTER COLUMN "hosting_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."app_runtimes"
  DROP CONSTRAINT "app_runtimes_hosting_type_not_null";
