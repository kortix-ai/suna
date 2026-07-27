-- Migration: add_account_github_installation_nango
--
-- Expand-only metadata for the Nango GitHub credential migration.
-- Every column is nullable so old API versions and legacy rows remain valid.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."account_github_installations"
  ADD COLUMN "nango_connection_id" text;
--> statement-breakpoint
ALTER TABLE "kortix"."account_github_installations"
  ADD COLUMN "nango_integration_id" text;
--> statement-breakpoint
ALTER TABLE "kortix"."account_github_installations"
  ADD COLUMN "connection_status" varchar(32);
--> statement-breakpoint
ALTER TABLE "kortix"."account_github_installations"
  ADD COLUMN "last_validated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "kortix"."account_github_installations"
  ADD COLUMN "last_error_code" varchar(64);
--> statement-breakpoint
ALTER TABLE "kortix"."account_github_installations"
  ADD COLUMN "last_error_message" text;
--> statement-breakpoint
ALTER TABLE "kortix"."account_github_installations"
  ADD COLUMN "disconnected_at" timestamp with time zone;
