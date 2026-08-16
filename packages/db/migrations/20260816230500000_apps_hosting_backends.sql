-- Migration: apps_hosting_backends
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Widen immutable deployment identity. Existing rows remain sandbox rows.
-- mixed-version-safe: old code writes only sandbox, which remains accepted.
ALTER TABLE "kortix"."app_deployments"
  DROP CONSTRAINT "app_deployments_hosting_type_check";--> statement-breakpoint
ALTER TABLE "kortix"."app_deployments"
  ADD CONSTRAINT "app_deployments_hosting_type_check"
  CHECK ("hosting_type" IN ('sandbox', 'managed_container')) NOT VALID;--> statement-breakpoint

-- A constant default uses PostgreSQL's missing-value optimization. It does not
-- rewrite existing rows. The temporary NOT VALID check establishes NOT NULL in
-- a separately validated phase before the final metadata-only SET NOT NULL.
ALTER TABLE "kortix"."app_runtimes"
  ADD COLUMN "hosting_type" varchar(24) DEFAULT 'sandbox';--> statement-breakpoint
ALTER TABLE "kortix"."app_runtimes"
  ADD COLUMN "origin_token_hash" text;--> statement-breakpoint

-- Keep the sandbox provider enum sandbox-only. Managed App backends use this
-- additive pricing-provider column. Legacy rows fall back to `provider`.
ALTER TABLE "kortix"."sandbox_compute_sessions"
  ADD COLUMN "compute_provider" varchar(32);--> statement-breakpoint
ALTER TABLE "kortix"."sandbox_compute_sessions"
  ADD CONSTRAINT "sandbox_compute_sessions_compute_provider_check"
  CHECK ("compute_provider" IS NULL OR "compute_provider" IN ('daytona', 'platinum', 'e2b', 'aws_lightsail')) NOT VALID;--> statement-breakpoint

-- mixed-version-safe: old sandbox writers still provide both fields. Managed
-- container rows have no appd control port and authenticate the public origin
-- through origin_token_hash instead.
ALTER TABLE "kortix"."app_runtimes"
  -- squawk-ignore ban-drop-not-null
  ALTER COLUMN "control_port" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."app_runtimes"
  -- squawk-ignore ban-drop-not-null
  ALTER COLUMN "control_token_hash" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "kortix"."app_runtimes"
  ADD CONSTRAINT "app_runtimes_hosting_type_not_null"
  CHECK ("hosting_type" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "kortix"."app_runtimes"
  ADD CONSTRAINT "app_runtimes_hosting_type_check"
  CHECK ("hosting_type" IN ('sandbox', 'managed_container')) NOT VALID;--> statement-breakpoint
ALTER TABLE "kortix"."app_runtimes"
  ADD CONSTRAINT "app_runtimes_auth_material_check"
  CHECK (
    ("hosting_type" = 'sandbox' AND "control_port" IS NOT NULL AND "control_token_hash" IS NOT NULL)
    OR
    ("hosting_type" = 'managed_container' AND "origin_token_hash" IS NOT NULL)
  ) NOT VALID;
