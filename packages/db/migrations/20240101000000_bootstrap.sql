-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Bootstrap Migration                                                       ║
-- ║                                                                             ║
-- ║  Creates schemas, enables extensions, and installs helper functions         ║
-- ║  that Drizzle ORM cannot manage (it only handles tables/indexes/enums).    ║
-- ║                                                                             ║
-- ║  After this migration runs, `drizzle-kit push` creates the actual tables.  ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- ─── Schemas ─────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS kortix;
CREATE SCHEMA IF NOT EXISTS basejump;

-- ─── Schema Permissions ─────────────────────────────────────────────────────
-- Supabase PostgREST requires USAGE on a schema before it can query tables
-- in that schema via .schema('kortix'). Without this, queries silently return
-- null even if table-level SELECT is granted.
GRANT USAGE ON SCHEMA kortix TO anon;
GRANT USAGE ON SCHEMA kortix TO authenticated;
GRANT USAGE ON SCHEMA kortix TO service_role;

-- ─── Drizzle-managed tables (kortix.* schema) ────────────────────────────
-- These tables are normally created by 'drizzle-kit push' but must exist
-- before subsequent ALTER migrations can run.


CREATE TYPE "kortix"."access_request_status" AS ENUM('pending', 'approved', 'rejected');
CREATE TYPE "kortix"."account_role" AS ENUM('owner', 'admin', 'member');
CREATE TYPE "kortix"."api_key_status" AS ENUM('active', 'revoked', 'expired');
CREATE TYPE "kortix"."api_key_type" AS ENUM('user', 'sandbox');
CREATE TYPE "kortix"."deployment_source" AS ENUM('git', 'code', 'files', 'tar');
CREATE TYPE "kortix"."deployment_status" AS ENUM('pending', 'building', 'deploying', 'active', 'failed', 'stopped');
CREATE TYPE "kortix"."platform_role" AS ENUM('user', 'admin', 'super_admin');
CREATE TYPE "kortix"."sandbox_provider" AS ENUM('daytona', 'local_docker', 'justavps');
CREATE TYPE "kortix"."sandbox_status" AS ENUM('provisioning', 'active', 'stopped', 'archived', 'pooled', 'error');
CREATE TYPE "kortix"."tunnel_capability" AS ENUM('filesystem', 'shell', 'network', 'apps', 'hardware', 'desktop', 'gpu');
CREATE TYPE "kortix"."tunnel_permission_request_status" AS ENUM('pending', 'approved', 'denied', 'expired');
CREATE TYPE "kortix"."tunnel_permission_status" AS ENUM('active', 'revoked', 'expired');
CREATE TYPE "kortix"."tunnel_status" AS ENUM('online', 'offline', 'connecting');
CREATE TABLE "kortix"."access_allowlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_type" varchar(20) NOT NULL,
	"value" varchar(255) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"company" varchar(255),
	"use_case" text,
	"status" "kortix"."access_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."account_deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"requested_at" timestamp with time zone DEFAULT now(),
	"scheduled_for" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone
);

CREATE TABLE "kortix"."account_members" (
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"account_role" "kortix"."account_role" DEFAULT 'owner' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."accounts" (
	"account_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"personal_account" boolean DEFAULT true NOT NULL,
	"setup_complete_at" timestamp with time zone,
	"setup_wizard_step" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."billing_customers" (
	"account_id" uuid NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"active" boolean,
	"provider" text
);

CREATE TABLE "kortix"."credit_accounts" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"balance" numeric(12, 4) DEFAULT '0' NOT NULL,
	"lifetime_granted" numeric(12, 4) DEFAULT '0' NOT NULL,
	"lifetime_purchased" numeric(12, 4) DEFAULT '0' NOT NULL,
	"lifetime_used" numeric(12, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"last_grant_date" timestamp with time zone,
	"tier" varchar(50) DEFAULT 'free',
	"billing_cycle_anchor" timestamp with time zone,
	"next_credit_grant" timestamp with time zone,
	"stripe_subscription_id" varchar(255),
	"expiring_credits" numeric(12, 4) DEFAULT '0' NOT NULL,
	"non_expiring_credits" numeric(12, 4) DEFAULT '0' NOT NULL,
	"daily_credits_balance" numeric(10, 2) DEFAULT '0' NOT NULL,
	"trial_status" varchar(20) DEFAULT 'none',
	"trial_started_at" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"is_grandfathered_free" boolean DEFAULT false,
	"last_processed_invoice_id" varchar(255),
	"commitment_type" varchar(50),
	"commitment_start_date" timestamp with time zone,
	"commitment_end_date" timestamp with time zone,
	"commitment_price_id" varchar(255),
	"can_cancel_after" timestamp with time zone,
	"last_renewal_period_start" bigint,
	"payment_status" text DEFAULT 'active',
	"last_payment_failure" timestamp with time zone,
	"scheduled_tier_change" text,
	"scheduled_tier_change_date" timestamp with time zone,
	"scheduled_price_id" text,
	"provider" varchar(20) DEFAULT 'stripe',
	"revenuecat_customer_id" varchar(255),
	"revenuecat_subscription_id" varchar(255),
	"revenuecat_cancelled_at" timestamp with time zone,
	"revenuecat_cancel_at_period_end" timestamp with time zone,
	"revenuecat_pending_change_product" text,
	"revenuecat_pending_change_date" timestamp with time zone,
	"revenuecat_pending_change_type" text,
	"revenuecat_product_id" text,
	"plan_type" varchar(50) DEFAULT 'monthly',
	"stripe_subscription_status" varchar(50),
	"last_daily_refresh" timestamp with time zone,
	"auto_topup_enabled" boolean DEFAULT true NOT NULL,
	"auto_topup_threshold" numeric(10, 2) DEFAULT '5' NOT NULL,
	"auto_topup_amount" numeric(10, 2) DEFAULT '20' NOT NULL,
	"auto_topup_last_charged" timestamp with time zone
);

CREATE TABLE "kortix"."credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" numeric(12, 4) NOT NULL,
	"balance_after" numeric(12, 4) NOT NULL,
	"type" text NOT NULL,
	"description" text,
	"reference_id" uuid,
	"reference_type" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"created_by" uuid,
	"is_expiring" boolean DEFAULT true,
	"expires_at" timestamp with time zone,
	"stripe_event_id" varchar(255),
	"idempotency_key" text,
	"processing_source" text,
	CONSTRAINT "kortix_unique_stripe_event" UNIQUE("stripe_event_id")
);

CREATE TABLE "kortix"."credit_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_dollars" numeric(10, 2) NOT NULL,
	"stripe_payment_intent_id" text,
	"stripe_charge_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"completed_at" timestamp with time zone,
	"provider" varchar(50) DEFAULT 'stripe',
	"revenuecat_transaction_id" varchar(255),
	"revenuecat_product_id" varchar(255)
);

CREATE TABLE "kortix"."credit_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_dollars" numeric(10, 2) NOT NULL,
	"description" text,
	"usage_type" text DEFAULT 'token_overage',
	"created_at" timestamp with time zone DEFAULT now(),
	"subscription_tier" text,
	"metadata" jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE "kortix"."deployments" (
	"deployment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"sandbox_id" uuid,
	"freestyle_id" text,
	"status" "kortix"."deployment_status" DEFAULT 'pending' NOT NULL,
	"source_type" "kortix"."deployment_source" NOT NULL,
	"source_ref" text,
	"framework" varchar(50),
	"domains" jsonb DEFAULT '[]'::jsonb,
	"live_url" text,
	"env_vars" jsonb DEFAULT '{}'::jsonb,
	"build_config" jsonb,
	"entrypoint" text,
	"error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."api_keys" (
	"key_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"public_key" varchar(64) NOT NULL,
	"secret_key_hash" varchar(128) NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"type" "kortix"."api_key_type" DEFAULT 'user' NOT NULL,
	"status" "kortix"."api_key_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."oauth_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."oauth_authorization_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(128) NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb,
	"code_challenge" text NOT NULL,
	"code_challenge_method" varchar(10) DEFAULT 'S256' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."oauth_clients" (
	"client_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_secret_hash" varchar(128) NOT NULL,
	"name" varchar(255) NOT NULL,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb,
	"scopes" jsonb DEFAULT '[]'::jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."oauth_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"access_token_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."platform_settings" (
	"key" varchar(255) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."platform_user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"role" "kortix"."platform_role" DEFAULT 'user' NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."pool_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "kortix"."sandbox_provider" NOT NULL,
	"server_type" varchar(64) NOT NULL,
	"location" varchar(64) NOT NULL,
	"desired_count" integer DEFAULT 2 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."pool_sandboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid,
	"provider" "kortix"."sandbox_provider" NOT NULL,
	"external_id" text NOT NULL,
	"base_url" text DEFAULT '' NOT NULL,
	"server_type" varchar(64) NOT NULL,
	"location" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'provisioning' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone
);

CREATE TABLE "kortix"."sandboxes" (
	"sandbox_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"provider" "kortix"."sandbox_provider" DEFAULT 'daytona' NOT NULL,
	"external_id" text,
	"status" "kortix"."sandbox_status" DEFAULT 'provisioning' NOT NULL,
	"base_url" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_included" boolean DEFAULT false NOT NULL,
	"stripe_subscription_item_id" text
);

CREATE TABLE "kortix"."server_entries" (
	"entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"id" varchar(128) NOT NULL,
	"account_id" uuid,
	"label" varchar(255) NOT NULL,
	"url" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"provider" "kortix"."sandbox_provider",
	"sandbox_id" text,
	"mapped_ports" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."tunnel_audit_logs" (
	"log_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tunnel_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"capability" "kortix"."tunnel_capability" NOT NULL,
	"operation" varchar(100) NOT NULL,
	"request_summary" jsonb DEFAULT '{}'::jsonb,
	"success" boolean NOT NULL,
	"duration_ms" integer,
	"bytes_transferred" integer,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."tunnel_connections" (
	"tunnel_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"sandbox_id" uuid,
	"name" varchar(255) NOT NULL,
	"status" "kortix"."tunnel_status" DEFAULT 'offline' NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb,
	"machine_info" jsonb DEFAULT '{}'::jsonb,
	"setup_token_hash" varchar(128),
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."tunnel_permission_requests" (
	"request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tunnel_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"capability" "kortix"."tunnel_capability" NOT NULL,
	"requested_scope" jsonb DEFAULT '{}'::jsonb,
	"reason" text,
	"status" "kortix"."tunnel_permission_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."tunnel_permissions" (
	"permission_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tunnel_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"capability" "kortix"."tunnel_capability" NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb,
	"status" "kortix"."tunnel_permission_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "kortix"."account_members" ADD CONSTRAINT "account_members_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "kortix"."deployments" ADD CONSTRAINT "deployments_sandbox_id_sandboxes_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "kortix"."sandboxes"("sandbox_id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "kortix"."api_keys" ADD CONSTRAINT "api_keys_sandbox_id_sandboxes_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "kortix"."sandboxes"("sandbox_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "kortix"."oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "kortix"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "kortix"."oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "kortix"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "kortix"."oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_access_token_id_oauth_access_tokens_id_fk" FOREIGN KEY ("access_token_id") REFERENCES "kortix"."oauth_access_tokens"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "kortix"."oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "kortix"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "kortix"."pool_sandboxes" ADD CONSTRAINT "pool_sandboxes_resource_id_pool_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "kortix"."pool_resources"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "kortix"."tunnel_audit_logs" ADD CONSTRAINT "tunnel_audit_logs_tunnel_id_tunnel_connections_tunnel_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "kortix"."tunnel_connections"("tunnel_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "kortix"."tunnel_connections" ADD CONSTRAINT "tunnel_connections_sandbox_id_sandboxes_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "kortix"."sandboxes"("sandbox_id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "kortix"."tunnel_permission_requests" ADD CONSTRAINT "tunnel_permission_requests_tunnel_id_tunnel_connections_tunnel_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "kortix"."tunnel_connections"("tunnel_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "kortix"."tunnel_permissions" ADD CONSTRAINT "tunnel_permissions_tunnel_id_tunnel_connections_tunnel_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "kortix"."tunnel_connections"("tunnel_id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "idx_access_allowlist_type_value" ON "kortix"."access_allowlist" USING btree ("entry_type","value");
CREATE INDEX "idx_access_requests_email" ON "kortix"."access_requests" USING btree ("email");
CREATE INDEX "idx_access_requests_status" ON "kortix"."access_requests" USING btree ("status");
CREATE INDEX "idx_account_members_user_id" ON "kortix"."account_members" USING btree ("user_id");
CREATE INDEX "idx_account_members_account_id" ON "kortix"."account_members" USING btree ("account_id");
CREATE UNIQUE INDEX "idx_account_members_user_account" ON "kortix"."account_members" USING btree ("user_id","account_id");
CREATE INDEX "idx_kortix_billing_customers_account_id" ON "kortix"."billing_customers" USING btree ("account_id");
CREATE INDEX "kortix_credit_accounts_account_id_idx" ON "kortix"."credit_accounts" USING btree ("account_id");
CREATE INDEX "idx_kortix_credit_ledger_idempotency" ON "kortix"."credit_ledger" USING btree ("idempotency_key") WHERE "kortix"."credit_ledger"."idempotency_key" IS NOT NULL;
CREATE INDEX "idx_deployments_account" ON "kortix"."deployments" USING btree ("account_id");
CREATE INDEX "idx_deployments_sandbox" ON "kortix"."deployments" USING btree ("sandbox_id");
CREATE INDEX "idx_deployments_status" ON "kortix"."deployments" USING btree ("status");
CREATE INDEX "idx_deployments_live_url" ON "kortix"."deployments" USING btree ("live_url");
CREATE INDEX "idx_deployments_created" ON "kortix"."deployments" USING btree ("created_at");
CREATE UNIQUE INDEX "idx_kortix_api_keys_public_key" ON "kortix"."api_keys" USING btree ("public_key");
CREATE INDEX "idx_kortix_api_keys_secret_hash" ON "kortix"."api_keys" USING btree ("secret_key_hash");
CREATE INDEX "idx_kortix_api_keys_sandbox" ON "kortix"."api_keys" USING btree ("sandbox_id");
CREATE INDEX "idx_kortix_api_keys_account" ON "kortix"."api_keys" USING btree ("account_id");
CREATE UNIQUE INDEX "idx_oauth_access_token_hash" ON "kortix"."oauth_access_tokens" USING btree ("token_hash");
CREATE INDEX "idx_oauth_access_tokens_client" ON "kortix"."oauth_access_tokens" USING btree ("client_id");
CREATE INDEX "idx_oauth_access_tokens_user" ON "kortix"."oauth_access_tokens" USING btree ("user_id");
CREATE UNIQUE INDEX "idx_oauth_codes_code" ON "kortix"."oauth_authorization_codes" USING btree ("code");
CREATE INDEX "idx_oauth_codes_client" ON "kortix"."oauth_authorization_codes" USING btree ("client_id");
CREATE INDEX "idx_oauth_codes_expires" ON "kortix"."oauth_authorization_codes" USING btree ("expires_at");
CREATE UNIQUE INDEX "idx_oauth_refresh_token_hash" ON "kortix"."oauth_refresh_tokens" USING btree ("token_hash");
CREATE INDEX "idx_oauth_refresh_tokens_client" ON "kortix"."oauth_refresh_tokens" USING btree ("client_id");
CREATE UNIQUE INDEX "idx_platform_user_roles_account_id" ON "kortix"."platform_user_roles" USING btree ("account_id");
CREATE INDEX "idx_platform_user_roles_role" ON "kortix"."platform_user_roles" USING btree ("role");
CREATE UNIQUE INDEX "idx_pool_resources_unique" ON "kortix"."pool_resources" USING btree ("provider","server_type","location");
CREATE INDEX "idx_pool_sandboxes_claim" ON "kortix"."pool_sandboxes" USING btree ("status","created_at");
CREATE UNIQUE INDEX "idx_pool_sandboxes_external_id_active" ON "kortix"."pool_sandboxes" USING btree ("external_id");
CREATE INDEX "idx_sandboxes_account" ON "kortix"."sandboxes" USING btree ("account_id");
CREATE INDEX "idx_sandboxes_external_id" ON "kortix"."sandboxes" USING btree ("external_id");
CREATE INDEX "idx_sandboxes_status" ON "kortix"."sandboxes" USING btree ("status");
CREATE INDEX "idx_server_entries_default" ON "kortix"."server_entries" USING btree ("is_default");
CREATE INDEX "idx_server_entries_account" ON "kortix"."server_entries" USING btree ("account_id");
CREATE UNIQUE INDEX "idx_server_entries_account_id" ON "kortix"."server_entries" USING btree ("account_id","id");
CREATE INDEX "idx_tunnel_audit_tunnel" ON "kortix"."tunnel_audit_logs" USING btree ("tunnel_id");
CREATE INDEX "idx_tunnel_audit_account" ON "kortix"."tunnel_audit_logs" USING btree ("account_id");
CREATE INDEX "idx_tunnel_audit_capability" ON "kortix"."tunnel_audit_logs" USING btree ("capability");
CREATE INDEX "idx_tunnel_audit_created" ON "kortix"."tunnel_audit_logs" USING btree ("created_at");
CREATE INDEX "idx_tunnel_connections_account" ON "kortix"."tunnel_connections" USING btree ("account_id");
CREATE INDEX "idx_tunnel_connections_sandbox" ON "kortix"."tunnel_connections" USING btree ("sandbox_id");
CREATE INDEX "idx_tunnel_connections_status" ON "kortix"."tunnel_connections" USING btree ("status");
CREATE INDEX "idx_tunnel_perm_requests_tunnel" ON "kortix"."tunnel_permission_requests" USING btree ("tunnel_id");
CREATE INDEX "idx_tunnel_perm_requests_account" ON "kortix"."tunnel_permission_requests" USING btree ("account_id");
CREATE INDEX "idx_tunnel_perm_requests_status" ON "kortix"."tunnel_permission_requests" USING btree ("status");
CREATE INDEX "idx_tunnel_permissions_tunnel" ON "kortix"."tunnel_permissions" USING btree ("tunnel_id");
CREATE INDEX "idx_tunnel_permissions_account" ON "kortix"."tunnel_permissions" USING btree ("account_id");
CREATE INDEX "idx_tunnel_permissions_capability" ON "kortix"."tunnel_permissions" USING btree ("capability");
CREATE INDEX "idx_tunnel_permissions_status" ON "kortix"."tunnel_permissions" USING btree ("status");
