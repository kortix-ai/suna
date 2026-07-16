CREATE SCHEMA "kortix";
--> statement-breakpoint
CREATE TYPE "kortix"."access_request_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "kortix"."account_group_source" AS ENUM('manual', 'scim', 'sso');--> statement-breakpoint
CREATE TYPE "kortix"."account_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "kortix"."api_key_status" AS ENUM('active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "kortix"."api_key_type" AS ENUM('user', 'sandbox');--> statement-breakpoint
CREATE TYPE "kortix"."change_request_status" AS ENUM('open', 'merged', 'closed');--> statement-breakpoint
CREATE TYPE "kortix"."executor_connection_profile_owner_type" AS ENUM('project', 'agent', 'member', 'subject', 'external');--> statement-breakpoint
CREATE TYPE "kortix"."executor_connection_profile_status" AS ENUM('active', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "kortix"."executor_connector_provider" AS ENUM('pipedream', 'mcp', 'openapi', 'graphql', 'http', 'channel', 'computer');--> statement-breakpoint
CREATE TYPE "kortix"."executor_connector_status" AS ENUM('active', 'disabled', 'needs_auth', 'error');--> statement-breakpoint
CREATE TYPE "kortix"."executor_credential_mode" AS ENUM('shared', 'per_user');--> statement-breakpoint
CREATE TYPE "kortix"."executor_default_mode" AS ENUM('risk', 'allow_all');--> statement-breakpoint
CREATE TYPE "kortix"."executor_execution_status" AS ENUM('ok', 'error', 'denied', 'pending_approval');--> statement-breakpoint
CREATE TYPE "kortix"."executor_policy_action" AS ENUM('always_run', 'require_approval', 'block');--> statement-breakpoint
CREATE TYPE "kortix"."executor_risk" AS ENUM('read', 'write', 'destructive');--> statement-breakpoint
CREATE TYPE "kortix"."gateway_budget_action" AS ENUM('block', 'warn');--> statement-breakpoint
CREATE TYPE "kortix"."gateway_budget_period" AS ENUM('day', 'week', 'month');--> statement-breakpoint
CREATE TYPE "kortix"."gateway_budget_scope" AS ENUM('project', 'member');--> statement-breakpoint
CREATE TYPE "kortix"."platform_role" AS ENUM('user', 'admin', 'super_admin');--> statement-breakpoint
CREATE TYPE "kortix"."project_access_request_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "kortix"."project_role" AS ENUM('manager', 'editor', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "kortix"."project_secret_scope" AS ENUM('runtime', 'connector');--> statement-breakpoint
CREATE TYPE "kortix"."project_session_connector_binding_source" AS ENUM('request', 'default');--> statement-breakpoint
CREATE TYPE "kortix"."project_session_status" AS ENUM('queued', 'branching', 'provisioning', 'running', 'stopped', 'failed', 'completed');--> statement-breakpoint
CREATE TYPE "kortix"."project_session_visibility" AS ENUM('private', 'project', 'restricted');--> statement-breakpoint
CREATE TYPE "kortix"."project_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "kortix"."review_item_kind" AS ENUM('change', 'approval', 'output', 'decision', 'batch');--> statement-breakpoint
CREATE TYPE "kortix"."review_item_risk" AS ENUM('none', 'low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "kortix"."review_item_source" AS ENUM('web', 'slack', 'agent');--> statement-breakpoint
CREATE TYPE "kortix"."review_item_status" AS ENUM('needs_you', 'waiting', 'approved', 'changes_requested', 'rejected', 'done', 'dismissed');--> statement-breakpoint
CREATE TYPE "kortix"."sandbox_provider" AS ENUM('daytona', 'platinum', 'e2b');--> statement-breakpoint
CREATE TYPE "kortix"."sandbox_status" AS ENUM('provisioning', 'active', 'stopped', 'archived', 'error');--> statement-breakpoint
CREATE TYPE "kortix"."scope_effect" AS ENUM('grant', 'revoke');--> statement-breakpoint
CREATE TYPE "kortix"."secret_grant_principal" AS ENUM('member', 'group');--> statement-breakpoint
CREATE TYPE "kortix"."secret_share_scope" AS ENUM('project', 'restricted');--> statement-breakpoint
CREATE TYPE "kortix"."session_lifecycle_command_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'dead_lettered');--> statement-breakpoint
CREATE TYPE "kortix"."session_sandbox_status" AS ENUM('provisioning', 'active', 'stopped', 'error', 'archived');--> statement-breakpoint
CREATE TYPE "kortix"."tunnel_capability" AS ENUM('filesystem', 'shell', 'network', 'apps', 'hardware', 'desktop', 'gpu');--> statement-breakpoint
CREATE TYPE "kortix"."tunnel_device_auth_status" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "kortix"."tunnel_permission_request_status" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "kortix"."tunnel_permission_status" AS ENUM('active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "kortix"."tunnel_status" AS ENUM('online', 'offline', 'connecting');--> statement-breakpoint
CREATE TABLE "kortix"."access_allowlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_type" varchar(20) NOT NULL,
	"value" varchar(255) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"company" varchar(255),
	"use_case" text,
	"status" "kortix"."access_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "kortix"."account_github_installation_states" (
	"state_nonce" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"installation_id" text,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."account_github_installations" (
	"installation_row_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"installation_id" text NOT NULL,
	"owner_login" varchar(255) NOT NULL,
	"owner_type" varchar(32) DEFAULT 'Organization' NOT NULL,
	"repository_selection" varchar(32),
	"permissions" jsonb DEFAULT '{}'::jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."account_group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "kortix"."account_groups" (
	"group_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text,
	"source" "kortix"."account_group_source" DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."account_invitations" (
	"invite_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"invited_by" uuid,
	"initial_role" "kortix"."account_role" DEFAULT 'member' NOT NULL,
	"bootstrap_grants" jsonb,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '14 days' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."account_members" (
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"account_role" "kortix"."account_role" DEFAULT 'owner' NOT NULL,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"scim_external_id" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_members_user_id_account_id_pk" PRIMARY KEY("user_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "kortix"."account_model_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text DEFAULT '' NOT NULL,
	"model" varchar(128) NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."account_session_activity" (
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" varchar(32),
	"revoked_by" uuid,
	"ip" text,
	"user_agent" text,
	CONSTRAINT "account_session_activity_account_id_user_id_session_id_pk" PRIMARY KEY("account_id","user_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "kortix"."account_sso_group_mappings" (
	"mapping_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"sso_provider_id" uuid NOT NULL,
	"claim_value" varchar(256) NOT NULL,
	"group_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."account_sso_providers" (
	"sso_provider_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"supabase_sso_provider_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"primary_domain" varchar(253) NOT NULL,
	"group_claim_name" varchar(128) DEFAULT 'groups' NOT NULL,
	"auto_create_members" boolean DEFAULT true NOT NULL,
	"auto_provision_groups" boolean DEFAULT false NOT NULL,
	"enforce_sso" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."account_tokens" (
	"token_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"name" varchar(255) NOT NULL,
	"public_key" varchar(64) NOT NULL,
	"secret_key_hash" varchar(128) NOT NULL,
	"status" "kortix"."api_key_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"agent_grant" jsonb,
	"session_id" text,
	"service_account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "kortix"."accounts" (
	"account_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"setup_complete_at" timestamp with time zone,
	"setup_wizard_step" integer DEFAULT 0 NOT NULL,
	"mfa_required" boolean DEFAULT false NOT NULL,
	"session_max_lifetime_minutes" integer,
	"session_idle_timeout_minutes" integer,
	"pat_max_lifetime_days" integer,
	"pat_require_expiry" boolean DEFAULT false NOT NULL,
	"pat_idle_revoke_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."audit_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."audit_webhooks" (
	"webhook_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"name" varchar(128) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"action_prefix" varchar(128),
	"last_delivered_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."billing_customers" (
	"account_id" uuid NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"active" boolean,
	"provider" text
);
--> statement-breakpoint
CREATE TABLE "kortix"."change_requests" (
	"cr_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"base_ref" text NOT NULL,
	"head_ref" text NOT NULL,
	"status" "kortix"."change_request_status" DEFAULT 'open' NOT NULL,
	"head_commit_sha" text,
	"base_commit_sha" text,
	"origin_session_id" text,
	"created_by" uuid NOT NULL,
	"merged_at" timestamp with time zone,
	"merged_by" uuid,
	"merge_commit_sha" text,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."chat_channel_bindings" (
	"binding_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"platform" varchar(32) NOT NULL,
	"workspace_id" varchar(128) NOT NULL,
	"channel_id" text NOT NULL,
	"channel_name" varchar(256),
	"channel_type" varchar(32),
	"picker_ts" varchar(64),
	"agent_name" varchar(128),
	"opencode_model" varchar(128),
	"conversation_policy" varchar(32) DEFAULT 'project_open' NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."chat_event_dedup" (
	"event_id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."chat_installs" (
	"install_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" varchar(32) NOT NULL,
	"workspace_id" varchar(128) NOT NULL,
	"project_id" uuid NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."chat_pending_auth_messages" (
	"pending_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"platform" varchar(32) DEFAULT 'slack' NOT NULL,
	"workspace_id" varchar(128) NOT NULL,
	"platform_user_id" varchar(128) NOT NULL,
	"envelope" jsonb NOT NULL,
	"event" jsonb NOT NULL,
	"slack_response_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."chat_thread_participants" (
	"participant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" varchar(32) NOT NULL,
	"workspace_id" varchar(128) NOT NULL,
	"thread_id" text NOT NULL,
	"session_id" text NOT NULL,
	"platform_user_id" varchar(128) NOT NULL,
	"user_id" uuid NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."chat_threads" (
	"thread_row_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"platform" varchar(32) NOT NULL,
	"workspace_id" varchar(128) NOT NULL,
	"thread_id" text NOT NULL,
	"session_id" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."chat_turn_streams" (
	"session_id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"team_id" varchar(128) NOT NULL,
	"channel" text NOT NULL,
	"trigger_ts" varchar(64) NOT NULL,
	"message_ts" varchar(64),
	"streaming" boolean DEFAULT false NOT NULL,
	"placeholder_active" boolean DEFAULT false NOT NULL,
	"finalized" boolean DEFAULT false NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"originating_event" jsonb NOT NULL,
	"channel_ref" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."chat_user_identities" (
	"identity_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" varchar(32) NOT NULL,
	"workspace_id" varchar(128) NOT NULL,
	"platform_user_id" varchar(128) NOT NULL,
	"user_id" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
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
	"auto_topup_enabled" boolean DEFAULT false NOT NULL,
	"auto_topup_threshold" numeric(10, 2) DEFAULT '5' NOT NULL,
	"auto_topup_amount" numeric(10, 2) DEFAULT '20' NOT NULL,
	"auto_topup_last_charged" timestamp with time zone,
	"billing_model" text DEFAULT 'legacy' NOT NULL,
	"seat_count" integer DEFAULT 1 NOT NULL,
	"seat_subscription_item_id" text,
	"auto_topup_customized" boolean DEFAULT false NOT NULL,
	"auto_topup_consecutive_failures" integer DEFAULT 0 NOT NULL,
	"auto_topup_disabled_reason" text,
	"demo_enterprise" boolean DEFAULT false NOT NULL,
	"max_concurrent_sessions" integer
);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "kortix"."executor_connection_profiles" (
	"profile_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"owner_type" "kortix"."executor_connection_profile_owner_type" DEFAULT 'project' NOT NULL,
	"owner_id" text,
	"label" varchar(255) NOT NULL,
	"status" "kortix"."executor_connection_profile_status" DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "executor_connection_profiles_owner_check" CHECK (("kortix"."executor_connection_profiles"."owner_type" = 'project' AND "kortix"."executor_connection_profiles"."owner_id" IS NULL) OR ("kortix"."executor_connection_profiles"."owner_type" <> 'project' AND "kortix"."executor_connection_profiles"."owner_id" IS NOT NULL AND btrim("kortix"."executor_connection_profiles"."owner_id") <> '')),
	CONSTRAINT "executor_connection_profiles_metadata_check" CHECK (jsonb_typeof("kortix"."executor_connection_profiles"."metadata") = 'object' AND octet_length("kortix"."executor_connection_profiles"."metadata"::text) <= 16384)
);
--> statement-breakpoint
CREATE TABLE "kortix"."executor_connector_actions" (
	"action_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"path" varchar(512) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"input_schema" jsonb,
	"output_schema" jsonb,
	"risk" "kortix"."executor_risk" DEFAULT 'read' NOT NULL,
	"binding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."executor_connector_grants" (
	"grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"principal_type" "kortix"."secret_grant_principal" NOT NULL,
	"principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."executor_connector_policies" (
	"policy_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"match" varchar(512) NOT NULL,
	"action" "kortix"."executor_policy_action" NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."executor_connectors" (
	"connector_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" varchar(128) NOT NULL,
	"name" varchar(255) NOT NULL,
	"provider_type" "kortix"."executor_connector_provider" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auth_secret" varchar(64),
	"share_scope" "kortix"."secret_share_scope" DEFAULT 'project' NOT NULL,
	"agent_scope" text[],
	"credential_mode" "kortix"."executor_credential_mode" DEFAULT 'shared' NOT NULL,
	"manifest_hash" varchar(64),
	"status" "kortix"."executor_connector_status" DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."executor_credentials" (
	"credential_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"profile_id" uuid,
	"user_id" uuid,
	"kind" varchar(32) DEFAULT 'secret' NOT NULL,
	"value_enc" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."executor_executions" (
	"execution_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"connector_id" uuid,
	"profile_id" uuid,
	"action_path" varchar(512) NOT NULL,
	"acting_user_id" uuid,
	"session_id" uuid,
	"status" "kortix"."executor_execution_status" NOT NULL,
	"risk" "kortix"."executor_risk",
	"request_digest" varchar(64),
	"result_summary" jsonb,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "kortix"."executor_project_policies" (
	"policy_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"match" varchar(512) NOT NULL,
	"action" "kortix"."executor_policy_action" NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."executor_project_settings" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"default_mode" "kortix"."executor_default_mode" DEFAULT 'allow_all' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."gateway_api_keys" (
	"key_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"key_prefix" varchar(24) NOT NULL,
	"secret_key_hash" varchar(128) NOT NULL,
	"status" "kortix"."api_key_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."gateway_budgets" (
	"budget_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"scope" "kortix"."gateway_budget_scope" NOT NULL,
	"subject_user_id" uuid,
	"limit_usd" numeric(12, 4) NOT NULL,
	"period" "kortix"."gateway_budget_period" DEFAULT 'month' NOT NULL,
	"action" "kortix"."gateway_budget_action" DEFAULT 'block' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."gateway_request_logs" (
	"log_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid,
	"actor_user_id" uuid,
	"session_id" text,
	"key_id" uuid,
	"requested_model" text NOT NULL,
	"resolved_model" text NOT NULL,
	"provider" text NOT NULL,
	"status" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error_code" text,
	"error_message" text,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"candidates_tried" jsonb DEFAULT '[]'::jsonb,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"upstream_cost" numeric(12, 6) DEFAULT '0' NOT NULL,
	"final_cost" numeric(12, 6) DEFAULT '0' NOT NULL,
	"streaming" boolean DEFAULT false NOT NULL,
	"billing_mode" text,
	"request" jsonb,
	"response" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."iam_policies" (
	"policy_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"principal_type" varchar(16) NOT NULL,
	"principal_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_type" varchar(16) NOT NULL,
	"scope_id" uuid,
	"expires_at" timestamp with time zone,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."iam_resource_grants" (
	"grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"resource_type" varchar(32) NOT NULL,
	"resource_id" text NOT NULL,
	"principal_type" varchar(16) NOT NULL,
	"principal_id" uuid NOT NULL,
	"effect" varchar(8) DEFAULT 'allow' NOT NULL,
	"expires_at" timestamp with time zone,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."iam_role_actions" (
	"role_id" uuid NOT NULL,
	"action" varchar(96) NOT NULL,
	CONSTRAINT "iam_role_actions_role_id_action_pk" PRIMARY KEY("role_id","action")
);
--> statement-breakpoint
CREATE TABLE "kortix"."iam_roles" (
	"role_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text,
	"scope_type" varchar(16) DEFAULT 'project' NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "kortix"."legacy_sandbox_migrations" (
	"migration_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid,
	"session_id" text,
	"status" varchar(32) DEFAULT 'planned' NOT NULL,
	"mode" varchar(32) DEFAULT 'dry_run' NOT NULL,
	"plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rollback" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opencode_archive" text,
	"error" text,
	"phase" varchar(32),
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "kortix"."oauth_clients" (
	"client_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_secret_hash" varchar(128) NOT NULL,
	"name" varchar(255) NOT NULL,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb,
	"scopes" jsonb DEFAULT '[]'::jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "kortix"."platform_settings" (
	"key" varchar(255) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."platform_user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"role" "kortix"."platform_role" DEFAULT 'user' NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_access_requests" (
	"request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"requester_email" varchar(255) NOT NULL,
	"message" text,
	"status" "kortix"."project_access_request_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_git_connections" (
	"connection_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"repo_url" text NOT NULL,
	"upstream_url" text,
	"managed" boolean DEFAULT false NOT NULL,
	"repo_owner" varchar(255),
	"repo_name" varchar(255),
	"external_repo_id" text,
	"default_branch" varchar(255) DEFAULT 'main' NOT NULL,
	"auth_method" varchar(64) NOT NULL,
	"installation_id" text,
	"credential_ref" text,
	"permissions" jsonb DEFAULT '{}'::jsonb,
	"visibility" varchar(32),
	"webhook_id" text,
	"status" varchar(32) DEFAULT 'connected' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"last_error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_git_credentials" (
	"credential_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"auth_method" varchar(64) DEFAULT 'token' NOT NULL,
	"value_enc" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_group_grants" (
	"project_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"role" "kortix"."project_role" DEFAULT 'member' NOT NULL,
	"granted_by" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_group_grants_project_id_group_id_pk" PRIMARY KEY("project_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_llm_routing_policies" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"vision_model" varchar(128),
	"default_fallback_models" jsonb,
	"default_fallback_on" text,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_llm_routing_policies_fallback_pair_check" CHECK (("kortix"."project_llm_routing_policies"."default_fallback_models" IS NULL AND "kortix"."project_llm_routing_policies"."default_fallback_on" IS NULL) OR ("kortix"."project_llm_routing_policies"."default_fallback_models" IS NOT NULL AND "kortix"."project_llm_routing_policies"."default_fallback_on" IN ('transient', 'any-error'))),
	CONSTRAINT "project_llm_routing_policies_rules_array_check" CHECK (jsonb_typeof("kortix"."project_llm_routing_policies"."rules") = 'array')
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_members" (
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_role" "kortix"."project_role" DEFAULT 'member' NOT NULL,
	"granted_by" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_secrets" (
	"secret_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"identifier" varchar(128) NOT NULL,
	"name" varchar(64) NOT NULL,
	"value_enc" text NOT NULL,
	"scope" "kortix"."project_secret_scope" DEFAULT 'runtime' NOT NULL,
	"owner_user_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_session_connector_bindings" (
	"session_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"connector_alias" varchar(128) NOT NULL,
	"connector_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"source" "kortix"."project_session_connector_binding_source" DEFAULT 'request' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_session_connector_bindings_session_id_connector_alias_pk" PRIMARY KEY("session_id","connector_alias")
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_session_grants" (
	"grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"principal_type" "kortix"."secret_grant_principal" NOT NULL,
	"principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_session_public_shares" (
	"share_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"session_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"created_by" uuid,
	"resource_type" text DEFAULT 'preview' NOT NULL,
	"label" text DEFAULT 'App preview' NOT NULL,
	"port" integer,
	"path" text DEFAULT '/' NOT NULL,
	"file_path" text,
	"mode" text DEFAULT 'view' NOT NULL,
	"allow_websocket" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_session_runtime_contexts" (
	"session_id" text PRIMARY KEY NOT NULL,
	"context" jsonb NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_session_runtime_contexts_byte_size_check" CHECK ("kortix"."project_session_runtime_contexts"."byte_size" >= 2 AND "kortix"."project_session_runtime_contexts"."byte_size" <= 16384),
	CONSTRAINT "project_session_runtime_contexts_object_check" CHECK (jsonb_typeof("kortix"."project_session_runtime_contexts"."context") = 'object')
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"branch_name" text NOT NULL,
	"base_ref" text DEFAULT 'main' NOT NULL,
	"sandbox_provider" "kortix"."sandbox_provider" DEFAULT 'daytona' NOT NULL,
	"sandbox_id" text,
	"sandbox_url" text,
	"opencode_session_id" text,
	"agent_name" text DEFAULT 'default' NOT NULL,
	"status" "kortix"."project_session_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_by" uuid,
	"visibility" "kortix"."project_session_visibility" DEFAULT 'private' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_snapshot_builds" (
	"build_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"branch" text DEFAULT '' NOT NULL,
	"snapshot_name" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"error_category" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "kortix"."project_trigger_runtime" (
	"project_id" uuid NOT NULL,
	"slug" varchar(128) NOT NULL,
	"last_fired_at" timestamp with time zone,
	"last_status" varchar(32),
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"owner_user_id" uuid,
	"session_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_trigger_runtime_project_id_slug_pk" PRIMARY KEY("project_id","slug")
);
--> statement-breakpoint
CREATE TABLE "kortix"."projects" (
	"project_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"repo_url" text NOT NULL,
	"default_branch" varchar(255) DEFAULT 'main' NOT NULL,
	"manifest_path" text DEFAULT 'kortix.yaml' NOT NULL,
	"status" "kortix"."project_status" DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"last_opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"total_ms" integer,
	"marks" jsonb DEFAULT '[]'::jsonb,
	"attempts" integer DEFAULT 1,
	"error_class" text,
	"error" text,
	"from_provider" text,
	"session_id" text,
	"account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."review_items" (
	"review_item_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"origin_session_id" text,
	"kind" "kortix"."review_item_kind" NOT NULL,
	"status" "kortix"."review_item_status" DEFAULT 'needs_you' NOT NULL,
	"risk" "kortix"."review_item_risk" DEFAULT 'none' NOT NULL,
	"source" "kortix"."review_item_source" DEFAULT 'agent' NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"acted_by" uuid,
	"acted_at" timestamp with time zone,
	"feedback" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."sandbox_compute_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"session_id" text,
	"actor_user_id" uuid,
	"provider" "kortix"."sandbox_provider" DEFAULT 'daytona' NOT NULL,
	"cpu_cores" integer NOT NULL,
	"memory_gb" integer NOT NULL,
	"disk_gb" integer NOT NULL,
	"gpu_count" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"last_billed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"ledger_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."sandbox_invites" (
	"invite_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"invited_by" uuid,
	"initial_role" "kortix"."account_role" DEFAULT 'member' NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '14 days' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."sandbox_member_scopes" (
	"sandbox_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"effect" "kortix"."scope_effect" NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."sandbox_members" (
	"sandbox_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"monthly_spend_cap_cents" integer,
	"current_period_cents" integer DEFAULT 0 NOT NULL,
	"current_period_start" bigint
);
--> statement-breakpoint
CREATE TABLE "kortix"."sandbox_templates" (
	"template_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"account_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'toml' NOT NULL,
	"provider" text DEFAULT 'daytona' NOT NULL,
	"image" text,
	"dockerfile_path" text,
	"entrypoint" text,
	"cpu" integer,
	"memory_gb" integer,
	"disk_gb" integer,
	"content_hash" text,
	"built_from_commit" text,
	"swap_key" text,
	"provider_snapshot_name" text,
	"provider_state" text DEFAULT 'missing' NOT NULL,
	"last_built_at" timestamp with time zone,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."sandboxes" (
	"sandbox_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"provider" text DEFAULT 'daytona' NOT NULL,
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
--> statement-breakpoint
CREATE TABLE "kortix"."scim_tokens" (
	"token_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"secret_hash" text NOT NULL,
	"public_prefix" varchar(32) NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "kortix"."service_accounts" (
	"service_account_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text,
	"secret_hash" text NOT NULL,
	"public_prefix" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"project_id" uuid,
	"agent_name" text,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_by" uuid
);
--> statement-breakpoint
CREATE TABLE "kortix"."session_lifecycle_commands" (
	"command_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_type" varchar(64) NOT NULL,
	"source" varchar(64) NOT NULL,
	"status" "kortix"."session_lifecycle_command_status" DEFAULT 'queued' NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text,
	"account_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"idempotency_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."session_sandboxes" (
	"sandbox_id" uuid PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" "kortix"."sandbox_provider" DEFAULT 'daytona' NOT NULL,
	"external_id" text,
	"base_url" text,
	"status" "kortix"."session_sandbox_status" DEFAULT 'provisioning' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_sandboxes_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "kortix"."session_tool_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"action_path" varchar(512) NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."stripe_webhook_events_processed" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."suna_account_migrations" (
	"migration_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid,
	"status" varchar(32) DEFAULT 'planned' NOT NULL,
	"mode" varchar(32) DEFAULT 'dry_run' NOT NULL,
	"plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"phase" varchar(32),
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."teams_pending_uploads" (
	"upload_id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"service_url" text NOT NULL,
	"conversation_id" text NOT NULL,
	"bot_id" varchar(128),
	"filename" text NOT NULL,
	"content_type" varchar(128),
	"content_base64" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "kortix"."tunnel_connections" (
	"tunnel_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"sandbox_id" uuid,
	"name" varchar(255) NOT NULL,
	"status" "kortix"."tunnel_status" DEFAULT 'offline' NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb,
	"machine_info" jsonb DEFAULT '{}'::jsonb,
	"relay_owner_id" varchar(255),
	"relay_owner_instance" varchar(255),
	"relay_owner_started_at" timestamp with time zone,
	"relay_owner_heartbeat_at" timestamp with time zone,
	"setup_token_hash" varchar(128),
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."tunnel_device_auth_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code" varchar(9) NOT NULL,
	"device_secret_hash" varchar(128) NOT NULL,
	"status" "kortix"."tunnel_device_auth_status" DEFAULT 'pending' NOT NULL,
	"machine_hostname" varchar(255),
	"account_id" uuid,
	"tunnel_id" uuid,
	"setup_token" varchar(64),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "kortix"."tunnel_rpc_forwards" (
	"request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tunnel_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"requester_relay_owner_id" varchar(255),
	"target_relay_owner_id" varchar(255) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"method" varchar(255) NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb,
	"result" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."usage_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid,
	"session_id" text,
	"actor_user_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"route" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"streaming" boolean DEFAULT false NOT NULL,
	"upstream_status" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."worker_leader_lease" (
	"lock_key" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."yolo_member_tokens" (
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"token_prefix" varchar(16) NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "yolo_member_tokens_user_id_account_id_pk" PRIMARY KEY("user_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "kortix"."account_github_installation_states" ADD CONSTRAINT "account_github_installation_states_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_github_installations" ADD CONSTRAINT "account_github_installations_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_group_members" ADD CONSTRAINT "account_group_members_group_id_account_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "kortix"."account_groups"("group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_groups" ADD CONSTRAINT "account_groups_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_invitations" ADD CONSTRAINT "account_invitations_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_members" ADD CONSTRAINT "account_members_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_model_preferences" ADD CONSTRAINT "account_model_preferences_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_session_activity" ADD CONSTRAINT "account_session_activity_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_sso_group_mappings" ADD CONSTRAINT "account_sso_group_mappings_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_sso_group_mappings" ADD CONSTRAINT "account_sso_group_mappings_sso_provider_id_account_sso_providers_sso_provider_id_fk" FOREIGN KEY ("sso_provider_id") REFERENCES "kortix"."account_sso_providers"("sso_provider_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_sso_group_mappings" ADD CONSTRAINT "account_sso_group_mappings_group_id_account_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "kortix"."account_groups"("group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_sso_providers" ADD CONSTRAINT "account_sso_providers_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_tokens" ADD CONSTRAINT "account_tokens_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_tokens" ADD CONSTRAINT "account_tokens_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_tokens" ADD CONSTRAINT "account_tokens_service_account_id_service_accounts_service_account_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "kortix"."service_accounts"("service_account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD CONSTRAINT "audit_events_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."audit_webhooks" ADD CONSTRAINT "audit_webhooks_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."change_requests" ADD CONSTRAINT "change_requests_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."change_requests" ADD CONSTRAINT "change_requests_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."change_requests" ADD CONSTRAINT "change_requests_origin_session_id_project_sessions_session_id_fk" FOREIGN KEY ("origin_session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."chat_channel_bindings" ADD CONSTRAINT "chat_channel_bindings_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."chat_installs" ADD CONSTRAINT "chat_installs_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."chat_pending_auth_messages" ADD CONSTRAINT "chat_pending_auth_messages_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."chat_thread_participants" ADD CONSTRAINT "chat_thread_participants_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."chat_threads" ADD CONSTRAINT "chat_threads_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."chat_threads" ADD CONSTRAINT "chat_threads_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."executor_connection_profiles" ADD CONSTRAINT "executor_connection_profiles_connector_tenant_fk" FOREIGN KEY ("account_id","project_id","connector_id") REFERENCES "kortix"."executor_connectors"("account_id","project_id","connector_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."executor_connector_actions" ADD CONSTRAINT "executor_connector_actions_connector_id_executor_connectors_connector_id_fk" FOREIGN KEY ("connector_id") REFERENCES "kortix"."executor_connectors"("connector_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."executor_connector_grants" ADD CONSTRAINT "executor_connector_grants_connector_id_executor_connectors_connector_id_fk" FOREIGN KEY ("connector_id") REFERENCES "kortix"."executor_connectors"("connector_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."executor_connector_policies" ADD CONSTRAINT "executor_connector_policies_connector_id_executor_connectors_connector_id_fk" FOREIGN KEY ("connector_id") REFERENCES "kortix"."executor_connectors"("connector_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."executor_connectors" ADD CONSTRAINT "executor_connectors_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."executor_connectors" ADD CONSTRAINT "executor_connectors_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."executor_credentials" ADD CONSTRAINT "executor_credentials_connector_id_executor_connectors_connector_id_fk" FOREIGN KEY ("connector_id") REFERENCES "kortix"."executor_connectors"("connector_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."executor_credentials" ADD CONSTRAINT "executor_credentials_connector_profile_fk" FOREIGN KEY ("connector_id","profile_id") REFERENCES "kortix"."executor_connection_profiles"("connector_id","profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."executor_executions" ADD CONSTRAINT "executor_executions_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."executor_executions" ADD CONSTRAINT "executor_executions_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."executor_executions" ADD CONSTRAINT "executor_executions_connector_id_executor_connectors_connector_id_fk" FOREIGN KEY ("connector_id") REFERENCES "kortix"."executor_connectors"("connector_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."executor_executions" ADD CONSTRAINT "executor_executions_profile_id_executor_connection_profiles_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "kortix"."executor_connection_profiles"("profile_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."executor_project_policies" ADD CONSTRAINT "executor_project_policies_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."executor_project_settings" ADD CONSTRAINT "executor_project_settings_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."gateway_api_keys" ADD CONSTRAINT "gateway_api_keys_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."gateway_api_keys" ADD CONSTRAINT "gateway_api_keys_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."gateway_budgets" ADD CONSTRAINT "gateway_budgets_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."gateway_request_logs" ADD CONSTRAINT "gateway_request_logs_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."gateway_request_logs" ADD CONSTRAINT "gateway_request_logs_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."iam_policies" ADD CONSTRAINT "iam_policies_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."iam_policies" ADD CONSTRAINT "iam_policies_role_id_iam_roles_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "kortix"."iam_roles"("role_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."iam_resource_grants" ADD CONSTRAINT "iam_resource_grants_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."iam_resource_grants" ADD CONSTRAINT "iam_resource_grants_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."iam_role_actions" ADD CONSTRAINT "iam_role_actions_role_id_iam_roles_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "kortix"."iam_roles"("role_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."iam_roles" ADD CONSTRAINT "iam_roles_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "kortix"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "kortix"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_access_token_id_oauth_access_tokens_id_fk" FOREIGN KEY ("access_token_id") REFERENCES "kortix"."oauth_access_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "kortix"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_access_requests" ADD CONSTRAINT "project_access_requests_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_access_requests" ADD CONSTRAINT "project_access_requests_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_git_connections" ADD CONSTRAINT "project_git_connections_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_git_connections" ADD CONSTRAINT "project_git_connections_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_git_credentials" ADD CONSTRAINT "project_git_credentials_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_git_credentials" ADD CONSTRAINT "project_git_credentials_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_group_grants" ADD CONSTRAINT "project_group_grants_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_group_grants" ADD CONSTRAINT "project_group_grants_group_id_account_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "kortix"."account_groups"("group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_group_grants" ADD CONSTRAINT "project_group_grants_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_llm_routing_policies" ADD CONSTRAINT "project_llm_routing_policies_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_members" ADD CONSTRAINT "project_members_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_members" ADD CONSTRAINT "project_members_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_secrets" ADD CONSTRAINT "project_secrets_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_connector_bindings" ADD CONSTRAINT "project_session_connector_bindings_session_tenant_fk" FOREIGN KEY ("account_id","project_id","session_id") REFERENCES "kortix"."project_sessions"("account_id","project_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_connector_bindings" ADD CONSTRAINT "project_session_connector_bindings_alias_tenant_fk" FOREIGN KEY ("account_id","project_id","connector_id","connector_alias") REFERENCES "kortix"."executor_connectors"("account_id","project_id","connector_id","slug") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_connector_bindings" ADD CONSTRAINT "project_session_connector_bindings_profile_tenant_fk" FOREIGN KEY ("account_id","project_id","connector_id","profile_id") REFERENCES "kortix"."executor_connection_profiles"("account_id","project_id","connector_id","profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_grants" ADD CONSTRAINT "project_session_grants_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_public_shares" ADD CONSTRAINT "project_session_public_shares_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_public_shares" ADD CONSTRAINT "project_session_public_shares_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_public_shares" ADD CONSTRAINT "project_session_public_shares_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_runtime_contexts" ADD CONSTRAINT "project_session_runtime_contexts_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_sessions" ADD CONSTRAINT "project_sessions_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_sessions" ADD CONSTRAINT "project_sessions_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_snapshot_builds" ADD CONSTRAINT "project_snapshot_builds_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_snapshot_builds" ADD CONSTRAINT "project_snapshot_builds_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD CONSTRAINT "project_trigger_runtime_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD CONSTRAINT "project_trigger_runtime_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."projects" ADD CONSTRAINT "projects_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."review_items" ADD CONSTRAINT "review_items_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."review_items" ADD CONSTRAINT "review_items_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."review_items" ADD CONSTRAINT "review_items_origin_session_id_project_sessions_session_id_fk" FOREIGN KEY ("origin_session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."sandbox_invites" ADD CONSTRAINT "sandbox_invites_sandbox_id_sandboxes_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "kortix"."sandboxes"("sandbox_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."sandbox_member_scopes" ADD CONSTRAINT "sandbox_member_scopes_sandbox_id_sandboxes_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "kortix"."sandboxes"("sandbox_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."sandbox_members" ADD CONSTRAINT "sandbox_members_sandbox_id_sandboxes_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "kortix"."sandboxes"("sandbox_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."sandbox_templates" ADD CONSTRAINT "sandbox_templates_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."sandbox_templates" ADD CONSTRAINT "sandbox_templates_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."scim_tokens" ADD CONSTRAINT "scim_tokens_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."service_accounts" ADD CONSTRAINT "service_accounts_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."service_accounts" ADD CONSTRAINT "service_accounts_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_lifecycle_commands" ADD CONSTRAINT "session_lifecycle_commands_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_lifecycle_commands" ADD CONSTRAINT "session_lifecycle_commands_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_lifecycle_commands" ADD CONSTRAINT "session_lifecycle_commands_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_tool_approvals" ADD CONSTRAINT "session_tool_approvals_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_tool_approvals" ADD CONSTRAINT "session_tool_approvals_connector_id_executor_connectors_connector_id_fk" FOREIGN KEY ("connector_id") REFERENCES "kortix"."executor_connectors"("connector_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_audit_logs" ADD CONSTRAINT "tunnel_audit_logs_tunnel_id_tunnel_connections_tunnel_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "kortix"."tunnel_connections"("tunnel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_connections" ADD CONSTRAINT "tunnel_connections_sandbox_id_sandboxes_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "kortix"."sandboxes"("sandbox_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_device_auth_requests" ADD CONSTRAINT "tunnel_device_auth_requests_tunnel_id_tunnel_connections_tunnel_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "kortix"."tunnel_connections"("tunnel_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_permission_requests" ADD CONSTRAINT "tunnel_permission_requests_tunnel_id_tunnel_connections_tunnel_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "kortix"."tunnel_connections"("tunnel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_permissions" ADD CONSTRAINT "tunnel_permissions_tunnel_id_tunnel_connections_tunnel_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "kortix"."tunnel_connections"("tunnel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_rpc_forwards" ADD CONSTRAINT "tunnel_rpc_forwards_tunnel_id_tunnel_connections_tunnel_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "kortix"."tunnel_connections"("tunnel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."usage_events" ADD CONSTRAINT "usage_events_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."usage_events" ADD CONSTRAINT "usage_events_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_access_allowlist_type_value" ON "kortix"."access_allowlist" USING btree ("entry_type","value");--> statement-breakpoint
CREATE INDEX "idx_access_requests_email" ON "kortix"."access_requests" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_access_requests_status" ON "kortix"."access_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_account_github_installation_states_account" ON "kortix"."account_github_installation_states" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_account_github_installation_states_expires_at" ON "kortix"."account_github_installation_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_account_github_installations_account" ON "kortix"."account_github_installations" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_github_installations_account_installation" ON "kortix"."account_github_installations" USING btree ("account_id","installation_id");--> statement-breakpoint
CREATE INDEX "idx_account_github_installations_owner" ON "kortix"."account_github_installations" USING btree ("owner_login");--> statement-breakpoint
CREATE INDEX "idx_account_group_members_user" ON "kortix"."account_group_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_account_groups_account" ON "kortix"."account_groups" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_groups_account_name" ON "kortix"."account_groups" USING btree ("account_id","name");--> statement-breakpoint
CREATE INDEX "idx_account_invitations_email" ON "kortix"."account_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_account_invitations_account" ON "kortix"."account_invitations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_account_invitations_expires_at" ON "kortix"."account_invitations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_invitations_pending" ON "kortix"."account_invitations" USING btree ("account_id","email");--> statement-breakpoint
CREATE INDEX "idx_account_members_user_id" ON "kortix"."account_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_account_members_account_id" ON "kortix"."account_members" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_members_user_account" ON "kortix"."account_members" USING btree ("user_id","account_id");--> statement-breakpoint
CREATE INDEX "idx_account_model_preferences_account" ON "kortix"."account_model_preferences" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_model_preferences_scope" ON "kortix"."account_model_preferences" USING btree ("account_id","scope","scope_key");--> statement-breakpoint
CREATE INDEX "idx_account_session_activity_account" ON "kortix"."account_session_activity" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_account_session_activity_user" ON "kortix"."account_session_activity" USING btree ("account_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_sso_mappings_claim" ON "kortix"."account_sso_group_mappings" USING btree ("account_id","claim_value");--> statement-breakpoint
CREATE INDEX "idx_account_sso_mappings_provider" ON "kortix"."account_sso_group_mappings" USING btree ("sso_provider_id");--> statement-breakpoint
CREATE INDEX "idx_account_sso_mappings_group" ON "kortix"."account_sso_group_mappings" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_sso_providers_account" ON "kortix"."account_sso_providers" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_sso_providers_supabase" ON "kortix"."account_sso_providers" USING btree ("supabase_sso_provider_id");--> statement-breakpoint
CREATE INDEX "idx_account_sso_providers_domain" ON "kortix"."account_sso_providers" USING btree ("primary_domain");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_tokens_public_key" ON "kortix"."account_tokens" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "idx_account_tokens_secret_hash" ON "kortix"."account_tokens" USING btree ("secret_key_hash");--> statement-breakpoint
CREATE INDEX "idx_account_tokens_account" ON "kortix"."account_tokens" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_account_tokens_user" ON "kortix"."account_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_account_tokens_project" ON "kortix"."account_tokens" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_audit_events_account_time" ON "kortix"."audit_events" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_audit_events_actor_time" ON "kortix"."audit_events" USING btree ("actor_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_audit_events_resource" ON "kortix"."audit_events" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "idx_audit_webhooks_account" ON "kortix"."audit_webhooks" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_audit_webhooks_enabled" ON "kortix"."audit_webhooks" USING btree ("account_id","enabled");--> statement-breakpoint
CREATE INDEX "idx_kortix_billing_customers_account_id" ON "kortix"."billing_customers" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_change_requests_account" ON "kortix"."change_requests" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_change_requests_project" ON "kortix"."change_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_change_requests_project_status" ON "kortix"."change_requests" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_change_requests_project_number" ON "kortix"."change_requests" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_channel_bindings_channel" ON "kortix"."chat_channel_bindings" USING btree ("platform","workspace_id","channel_id");--> statement-breakpoint
CREATE INDEX "idx_chat_channel_bindings_project" ON "kortix"."chat_channel_bindings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_chat_event_dedup_expiry" ON "kortix"."chat_event_dedup" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_installs_workspace_project" ON "kortix"."chat_installs" USING btree ("platform","workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_chat_installs_workspace" ON "kortix"."chat_installs" USING btree ("platform","workspace_id");--> statement-breakpoint
CREATE INDEX "idx_chat_installs_project" ON "kortix"."chat_installs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_chat_pending_auth_messages_lookup" ON "kortix"."chat_pending_auth_messages" USING btree ("workspace_id","platform_user_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_chat_pending_auth_messages_expiry" ON "kortix"."chat_pending_auth_messages" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_thread_participants_thread_user" ON "kortix"."chat_thread_participants" USING btree ("platform","workspace_id","thread_id","platform_user_id");--> statement-breakpoint
CREATE INDEX "idx_chat_thread_participants_session" ON "kortix"."chat_thread_participants" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_chat_thread_participants_user" ON "kortix"."chat_thread_participants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_threads_thread" ON "kortix"."chat_threads" USING btree ("platform","workspace_id","thread_id");--> statement-breakpoint
CREATE INDEX "idx_chat_threads_project" ON "kortix"."chat_threads" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_chat_threads_session" ON "kortix"."chat_threads" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_chat_turn_streams_expiry" ON "kortix"."chat_turn_streams" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_user_identities_platform_user" ON "kortix"."chat_user_identities" USING btree ("platform","workspace_id","platform_user_id");--> statement-breakpoint
CREATE INDEX "idx_chat_user_identities_user" ON "kortix"."chat_user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "kortix_credit_accounts_account_id_idx" ON "kortix"."credit_accounts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_credit_accounts_billing_model" ON "kortix"."credit_accounts" USING btree ("billing_model");--> statement-breakpoint
CREATE INDEX "idx_kortix_credit_ledger_idempotency" ON "kortix"."credit_ledger" USING btree ("idempotency_key") WHERE "kortix"."credit_ledger"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_executor_connection_profiles_tenant_identity" ON "kortix"."executor_connection_profiles" USING btree ("account_id","project_id","connector_id","profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_executor_connection_profiles_connector_identity" ON "kortix"."executor_connection_profiles" USING btree ("connector_id","profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_executor_connection_profiles_default" ON "kortix"."executor_connection_profiles" USING btree ("connector_id") WHERE "kortix"."executor_connection_profiles"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_executor_connection_profiles_owner" ON "kortix"."executor_connection_profiles" USING btree ("connector_id","owner_type","owner_id") WHERE "kortix"."executor_connection_profiles"."owner_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_executor_connection_profiles_project" ON "kortix"."executor_connection_profiles" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_executor_connection_profiles_connector" ON "kortix"."executor_connection_profiles" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "idx_executor_connector_actions_connector" ON "kortix"."executor_connector_actions" USING btree ("connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_executor_connector_actions_path" ON "kortix"."executor_connector_actions" USING btree ("connector_id","path");--> statement-breakpoint
CREATE INDEX "idx_executor_connector_grants_connector" ON "kortix"."executor_connector_grants" USING btree ("connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_executor_connector_grants_unique" ON "kortix"."executor_connector_grants" USING btree ("connector_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "idx_executor_connector_policies_connector" ON "kortix"."executor_connector_policies" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "idx_executor_connectors_project" ON "kortix"."executor_connectors" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_executor_connectors_account" ON "kortix"."executor_connectors" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_executor_connectors_project_slug" ON "kortix"."executor_connectors" USING btree ("project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_executor_connectors_tenant_identity" ON "kortix"."executor_connectors" USING btree ("account_id","project_id","connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_executor_connectors_tenant_alias" ON "kortix"."executor_connectors" USING btree ("account_id","project_id","connector_id","slug");--> statement-breakpoint
CREATE INDEX "idx_executor_credentials_connector" ON "kortix"."executor_credentials" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "idx_executor_credentials_profile" ON "kortix"."executor_credentials" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_executor_credentials_profile_unique" ON "kortix"."executor_credentials" USING btree ("profile_id") WHERE "kortix"."executor_credentials"."profile_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_executor_credentials_legacy_connector_unique" ON "kortix"."executor_credentials" USING btree ("connector_id") WHERE "kortix"."executor_credentials"."profile_id" is null;--> statement-breakpoint
CREATE INDEX "idx_executor_executions_project" ON "kortix"."executor_executions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_executor_executions_project_session_created" ON "kortix"."executor_executions" USING btree ("project_id","session_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_executor_executions_connector" ON "kortix"."executor_executions" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "idx_executor_executions_profile" ON "kortix"."executor_executions" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "idx_executor_executions_status" ON "kortix"."executor_executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_executor_project_policies_project" ON "kortix"."executor_project_policies" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_gateway_keys_secret_hash" ON "kortix"."gateway_api_keys" USING btree ("secret_key_hash");--> statement-breakpoint
CREATE INDEX "idx_gateway_keys_project" ON "kortix"."gateway_api_keys" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_gateway_keys_account" ON "kortix"."gateway_api_keys" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_gateway_budgets_project" ON "kortix"."gateway_budgets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_gateway_budgets_lookup" ON "kortix"."gateway_budgets" USING btree ("project_id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_gateway_logs_request_id" ON "kortix"."gateway_request_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_gateway_logs_account_time" ON "kortix"."gateway_request_logs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_gateway_logs_project_time" ON "kortix"."gateway_request_logs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_gateway_logs_model" ON "kortix"."gateway_request_logs" USING btree ("provider","resolved_model");--> statement-breakpoint
CREATE INDEX "idx_gateway_logs_account_ok" ON "kortix"."gateway_request_logs" USING btree ("account_id","ok");--> statement-breakpoint
CREATE INDEX "idx_gateway_logs_session" ON "kortix"."gateway_request_logs" USING btree ("project_id","session_id");--> statement-breakpoint
CREATE INDEX "idx_iam_policies_account_principal" ON "kortix"."iam_policies" USING btree ("account_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "idx_iam_policies_scope" ON "kortix"."iam_policies" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "idx_iam_policies_role" ON "kortix"."iam_policies" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_iam_resource_grants" ON "kortix"."iam_resource_grants" USING btree ("project_id","resource_type","resource_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "idx_iam_resource_grants_project_type" ON "kortix"."iam_resource_grants" USING btree ("project_id","resource_type");--> statement-breakpoint
CREATE INDEX "idx_iam_resource_grants_resource" ON "kortix"."iam_resource_grants" USING btree ("project_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "idx_iam_resource_grants_principal" ON "kortix"."iam_resource_grants" USING btree ("principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "idx_iam_resource_grants_account" ON "kortix"."iam_resource_grants" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_iam_roles_account" ON "kortix"."iam_roles" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_iam_roles_account_key" ON "kortix"."iam_roles" USING btree ("account_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_kortix_api_keys_public_key" ON "kortix"."api_keys" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "idx_kortix_api_keys_secret_hash" ON "kortix"."api_keys" USING btree ("secret_key_hash");--> statement-breakpoint
CREATE INDEX "idx_kortix_api_keys_sandbox" ON "kortix"."api_keys" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "idx_kortix_api_keys_account" ON "kortix"."api_keys" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_legacy_sandbox_migrations_run" ON "kortix"."legacy_sandbox_migrations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_legacy_sandbox_migrations_sandbox" ON "kortix"."legacy_sandbox_migrations" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "idx_legacy_sandbox_migrations_status" ON "kortix"."legacy_sandbox_migrations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_legacy_sandbox_migrations_account" ON "kortix"."legacy_sandbox_migrations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_legacy_sandbox_migrations_heartbeat" ON "kortix"."legacy_sandbox_migrations" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_access_token_hash" ON "kortix"."oauth_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_oauth_access_tokens_client" ON "kortix"."oauth_access_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_access_tokens_user" ON "kortix"."oauth_access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_codes_code" ON "kortix"."oauth_authorization_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_oauth_codes_client" ON "kortix"."oauth_authorization_codes" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_codes_expires" ON "kortix"."oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_refresh_token_hash" ON "kortix"."oauth_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_oauth_refresh_tokens_client" ON "kortix"."oauth_refresh_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_platform_user_roles_account_id" ON "kortix"."platform_user_roles" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_platform_user_roles_role" ON "kortix"."platform_user_roles" USING btree ("role");--> statement-breakpoint
CREATE INDEX "idx_project_access_requests_project" ON "kortix"."project_access_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_access_requests_account" ON "kortix"."project_access_requests" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_project_access_requests_requester" ON "kortix"."project_access_requests" USING btree ("requester_user_id");--> statement-breakpoint
CREATE INDEX "idx_project_access_requests_status" ON "kortix"."project_access_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_access_requests_pending_unique" ON "kortix"."project_access_requests" USING btree ("project_id","requester_user_id") WHERE "kortix"."project_access_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_project_git_connections_account" ON "kortix"."project_git_connections" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_git_connections_project" ON "kortix"."project_git_connections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_git_connections_provider_repo" ON "kortix"."project_git_connections" USING btree ("provider","external_repo_id");--> statement-breakpoint
CREATE INDEX "idx_project_git_connections_status" ON "kortix"."project_git_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_project_git_credentials_account" ON "kortix"."project_git_credentials" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_git_credentials_project_provider" ON "kortix"."project_git_credentials" USING btree ("project_id","provider");--> statement-breakpoint
CREATE INDEX "idx_project_group_grants_project" ON "kortix"."project_group_grants" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_group_grants_group" ON "kortix"."project_group_grants" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_project_group_grants_account" ON "kortix"."project_group_grants" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_project_members_account_user" ON "kortix"."project_members" USING btree ("account_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_project_members_project" ON "kortix"."project_members" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_members_project_user" ON "kortix"."project_members" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_project_secrets_project" ON "kortix"."project_secrets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_secrets_project_name" ON "kortix"."project_secrets" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_secrets_project_identifier_shared" ON "kortix"."project_secrets" USING btree ("project_id","identifier") WHERE "kortix"."project_secrets"."owner_user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_secrets_project_name_owner" ON "kortix"."project_secrets" USING btree ("project_id","name","owner_user_id") WHERE "kortix"."project_secrets"."owner_user_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_project_session_connector_bindings_profile" ON "kortix"."project_session_connector_bindings" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "idx_project_session_connector_bindings_project" ON "kortix"."project_session_connector_bindings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_session_grants_session" ON "kortix"."project_session_grants" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_session_grants_unique" ON "kortix"."project_session_grants" USING btree ("session_id","principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_session_public_shares_token_hash" ON "kortix"."project_session_public_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_project_session_public_shares_session" ON "kortix"."project_session_public_shares" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_project_session_public_shares_project" ON "kortix"."project_session_public_shares" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_session_runtime_contexts_updated" ON "kortix"."project_session_runtime_contexts" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_project_sessions_account" ON "kortix"."project_sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_project_sessions_project" ON "kortix"."project_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_sessions_status" ON "kortix"."project_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_project_sessions_created_by" ON "kortix"."project_sessions" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_sessions_project_branch" ON "kortix"."project_sessions" USING btree ("project_id","branch_name");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_sessions_tenant_identity" ON "kortix"."project_sessions" USING btree ("account_id","project_id","session_id");--> statement-breakpoint
CREATE INDEX "idx_project_snapshot_builds_project_recent" ON "kortix"."project_snapshot_builds" USING btree ("project_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_project_snapshot_builds_status" ON "kortix"."project_snapshot_builds" USING btree ("project_id","status","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_project_trigger_runtime_owner_user" ON "kortix"."project_trigger_runtime" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_projects_account" ON "kortix"."projects" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_projects_status" ON "kortix"."projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_projects_updated" ON "kortix"."projects" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_projects_account_repo" ON "kortix"."projects" USING btree ("account_id","repo_url");--> statement-breakpoint
CREATE INDEX "idx_provider_events_provider" ON "kortix"."provider_events" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "idx_provider_events_kind" ON "kortix"."provider_events" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "idx_provider_events_outcome" ON "kortix"."provider_events" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "idx_provider_events_created" ON "kortix"."provider_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_review_items_project" ON "kortix"."review_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_review_items_project_status" ON "kortix"."review_items" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "idx_review_items_project_kind" ON "kortix"."review_items" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "idx_review_items_created" ON "kortix"."review_items" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_sandbox_compute_sessions_account_time" ON "kortix"."sandbox_compute_sessions" USING btree ("account_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_sandbox_compute_sessions_provider_time" ON "kortix"."sandbox_compute_sessions" USING btree ("provider","started_at");--> statement-breakpoint
CREATE INDEX "idx_sandbox_compute_sessions_open" ON "kortix"."sandbox_compute_sessions" USING btree ("sandbox_id") WHERE "kortix"."sandbox_compute_sessions"."ended_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_sandbox_compute_sessions_one_open" ON "kortix"."sandbox_compute_sessions" USING btree ("sandbox_id") WHERE "kortix"."sandbox_compute_sessions"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_sandbox_compute_sessions_last_billed" ON "kortix"."sandbox_compute_sessions" USING btree ("last_billed_at") WHERE "kortix"."sandbox_compute_sessions"."state" = 'active';--> statement-breakpoint
CREATE INDEX "idx_sandbox_invites_email" ON "kortix"."sandbox_invites" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_sandbox_invites_sandbox" ON "kortix"."sandbox_invites" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "idx_sandbox_invites_expires_at" ON "kortix"."sandbox_invites" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sandbox_member_scopes_unique" ON "kortix"."sandbox_member_scopes" USING btree ("sandbox_id","user_id","scope");--> statement-breakpoint
CREATE INDEX "idx_sandbox_member_scopes_lookup" ON "kortix"."sandbox_member_scopes" USING btree ("sandbox_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sandbox_members_unique" ON "kortix"."sandbox_members" USING btree ("sandbox_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_sandbox_members_user" ON "kortix"."sandbox_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sandbox_members_sandbox" ON "kortix"."sandbox_members" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "idx_sandbox_templates_project" ON "kortix"."sandbox_templates" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_sandbox_templates_shared" ON "kortix"."sandbox_templates" USING btree ("is_shared");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sandbox_templates_project_slug" ON "kortix"."sandbox_templates" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "idx_sandboxes_account" ON "kortix"."sandboxes" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_sandboxes_external_id" ON "kortix"."sandboxes" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "idx_sandboxes_status" ON "kortix"."sandboxes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_scim_tokens_account" ON "kortix"."scim_tokens" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_scim_tokens_secret_hash" ON "kortix"."scim_tokens" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "idx_service_accounts_account" ON "kortix"."service_accounts" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_service_accounts_secret_hash" ON "kortix"."service_accounts" USING btree ("secret_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_service_accounts_account_name" ON "kortix"."service_accounts" USING btree ("account_id","name") WHERE agent_name IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_service_accounts_agent" ON "kortix"."service_accounts" USING btree ("account_id","project_id","agent_name") WHERE agent_name IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_session_lifecycle_commands_idempotency" ON "kortix"."session_lifecycle_commands" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_session_lifecycle_commands_due" ON "kortix"."session_lifecycle_commands" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "idx_session_lifecycle_commands_project" ON "kortix"."session_lifecycle_commands" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_session_lifecycle_commands_session" ON "kortix"."session_lifecycle_commands" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_session_lifecycle_commands_locked" ON "kortix"."session_lifecycle_commands" USING btree ("locked_until");--> statement-breakpoint
CREATE INDEX "idx_session_sandboxes_session" ON "kortix"."session_sandboxes" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_session_sandboxes_project" ON "kortix"."session_sandboxes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_session_sandboxes_account" ON "kortix"."session_sandboxes" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_session_sandboxes_status" ON "kortix"."session_sandboxes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_session_sandboxes_external_id" ON "kortix"."session_sandboxes" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_tool_approvals_unique" ON "kortix"."session_tool_approvals" USING btree ("session_id","connector_id","action_path");--> statement-breakpoint
CREATE INDEX "session_tool_approvals_session_idx" ON "kortix"."session_tool_approvals" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_stripe_webhook_events_processed_at" ON "kortix"."stripe_webhook_events_processed" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "idx_suna_account_migrations_status" ON "kortix"."suna_account_migrations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_suna_account_migrations_account" ON "kortix"."suna_account_migrations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_suna_account_migrations_heartbeat" ON "kortix"."suna_account_migrations" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "idx_teams_pending_uploads_expiry" ON "kortix"."teams_pending_uploads" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_tunnel_audit_tunnel" ON "kortix"."tunnel_audit_logs" USING btree ("tunnel_id");--> statement-breakpoint
CREATE INDEX "idx_tunnel_audit_account" ON "kortix"."tunnel_audit_logs" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_tunnel_audit_capability" ON "kortix"."tunnel_audit_logs" USING btree ("capability");--> statement-breakpoint
CREATE INDEX "idx_tunnel_audit_created" ON "kortix"."tunnel_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_tunnel_connections_account" ON "kortix"."tunnel_connections" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_tunnel_connections_sandbox" ON "kortix"."tunnel_connections" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "idx_tunnel_connections_status" ON "kortix"."tunnel_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tunnel_connections_relay_owner" ON "kortix"."tunnel_connections" USING btree ("relay_owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tunnel_device_auth_code" ON "kortix"."tunnel_device_auth_requests" USING btree ("device_code");--> statement-breakpoint
CREATE INDEX "idx_tunnel_device_auth_status" ON "kortix"."tunnel_device_auth_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tunnel_device_auth_expires" ON "kortix"."tunnel_device_auth_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_tunnel_perm_requests_tunnel" ON "kortix"."tunnel_permission_requests" USING btree ("tunnel_id");--> statement-breakpoint
CREATE INDEX "idx_tunnel_perm_requests_account" ON "kortix"."tunnel_permission_requests" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_tunnel_perm_requests_status" ON "kortix"."tunnel_permission_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tunnel_permissions_tunnel" ON "kortix"."tunnel_permissions" USING btree ("tunnel_id");--> statement-breakpoint
CREATE INDEX "idx_tunnel_permissions_account" ON "kortix"."tunnel_permissions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_tunnel_permissions_capability" ON "kortix"."tunnel_permissions" USING btree ("capability");--> statement-breakpoint
CREATE INDEX "idx_tunnel_permissions_status" ON "kortix"."tunnel_permissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tunnel_rpc_forwards_target_status" ON "kortix"."tunnel_rpc_forwards" USING btree ("target_relay_owner_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_tunnel_rpc_forwards_expiry" ON "kortix"."tunnel_rpc_forwards" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_tunnel_rpc_forwards_tunnel" ON "kortix"."tunnel_rpc_forwards" USING btree ("tunnel_id");--> statement-breakpoint
CREATE INDEX "idx_usage_events_account_time" ON "kortix"."usage_events" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_usage_events_project_time" ON "kortix"."usage_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_usage_events_session" ON "kortix"."usage_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_usage_events_model" ON "kortix"."usage_events" USING btree ("provider","model");--> statement-breakpoint
CREATE INDEX "idx_yolo_member_tokens_prefix" ON "kortix"."yolo_member_tokens" USING btree ("token_prefix") WHERE "kortix"."yolo_member_tokens"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_yolo_member_tokens_account" ON "kortix"."yolo_member_tokens" USING btree ("account_id");