-- ============================================================================
-- 00000000000098  align_legacy_staging
-- Brings a legacy-lineage database forward to the current kortix schema.
-- PURELY ADDITIVE + IDEMPOTENT: creates 49 tables, 18 enums, 17 columns. Drops NOTHING.
-- Safe to re-run. Destructive legacy cleanup is intentionally excluded (needs sign-off).
-- ============================================================================

SET search_path = kortix, public;

-- ---- enums (18) ----
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='account_group_source' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."account_group_source" AS ENUM ('manual', 'scim');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='change_request_status' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."change_request_status" AS ENUM ('open', 'merged', 'closed');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='executor_connector_provider' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."executor_connector_provider" AS ENUM ('pipedream', 'mcp', 'openapi', 'graphql', 'http');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='executor_connector_status' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."executor_connector_status" AS ENUM ('active', 'disabled', 'needs_auth', 'error');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='executor_credential_mode' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."executor_credential_mode" AS ENUM ('shared', 'per_user');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='executor_default_mode' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."executor_default_mode" AS ENUM ('risk', 'allow_all');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='executor_execution_status' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."executor_execution_status" AS ENUM ('ok', 'error', 'denied', 'pending_approval');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='executor_policy_action' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."executor_policy_action" AS ENUM ('always_run', 'require_approval', 'block');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='executor_risk' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."executor_risk" AS ENUM ('read', 'write', 'destructive');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='project_role' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."project_role" AS ENUM ('manager', 'editor', 'viewer');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='project_secret_scope' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."project_secret_scope" AS ENUM ('runtime', 'connector');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='project_session_status' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."project_session_status" AS ENUM ('queued', 'branching', 'provisioning', 'running', 'stopped', 'failed', 'completed');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='project_session_visibility' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."project_session_visibility" AS ENUM ('private', 'project', 'restricted');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='project_status' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."project_status" AS ENUM ('active', 'archived');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='secret_grant_principal' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."secret_grant_principal" AS ENUM ('member', 'group');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='secret_share_scope' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."secret_share_scope" AS ENUM ('project', 'restricted');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='session_sandbox_status' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."session_sandbox_status" AS ENUM ('provisioning', 'active', 'stopped', 'error', 'archived');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='vault_item_kind' AND n.nspname='kortix') THEN
    CREATE TYPE kortix."vault_item_kind" AS ENUM ('env', 'api_key', 'oauth_token', 'oauth_client', 'connection_secret');
  END IF;
END $$;

-- ---- tables (49) ----
CREATE TABLE IF NOT EXISTS kortix."account_github_installation_states" (
  "state_nonce" text NOT NULL,
  "account_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "installation_id" text,
  "consumed_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_github_installation_states_pkey" PRIMARY KEY (state_nonce)
);
CREATE TABLE IF NOT EXISTS kortix."account_github_installations" (
  "account_id" uuid NOT NULL,
  "installation_id" text NOT NULL,
  "owner_login" character varying(255) NOT NULL,
  "owner_type" character varying(32) DEFAULT 'Organization'::character varying NOT NULL,
  "repository_selection" character varying(32),
  "permissions" jsonb DEFAULT '{}'::jsonb,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "installation_row_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  CONSTRAINT "account_github_installations_pkey" PRIMARY KEY (installation_row_id)
);
CREATE TABLE IF NOT EXISTS kortix."account_group_members" (
  "group_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "added_by" uuid,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_group_members_pkey" PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS kortix."account_groups" (
  "group_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "name" character varying(128) NOT NULL,
  "description" text,
  "source" kortix.account_group_source DEFAULT 'manual'::kortix.account_group_source NOT NULL,
  "external_id" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_groups_pkey" PRIMARY KEY (group_id)
);
CREATE TABLE IF NOT EXISTS kortix."account_invitations" (
  "invite_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "email" character varying(255) NOT NULL,
  "invited_by" uuid,
  "initial_role" kortix.account_role DEFAULT 'member'::kortix.account_role NOT NULL,
  "accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone DEFAULT (now() + '14 days'::interval) NOT NULL,
  "bootstrap_grants" jsonb,
  CONSTRAINT "account_invitations_pkey" PRIMARY KEY (invite_id)
);
CREATE TABLE IF NOT EXISTS kortix."account_session_activity" (
  "account_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_reason" character varying(32),
  "revoked_by" uuid,
  "ip" text,
  "user_agent" text,
  CONSTRAINT "account_session_activity_pkey" PRIMARY KEY (account_id, user_id, session_id)
);
CREATE TABLE IF NOT EXISTS kortix."account_sso_group_mappings" (
  "mapping_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "sso_provider_id" uuid NOT NULL,
  "claim_value" character varying(256) NOT NULL,
  "group_id" uuid NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_sso_group_mappings_pkey" PRIMARY KEY (mapping_id)
);
CREATE TABLE IF NOT EXISTS kortix."account_sso_providers" (
  "sso_provider_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "supabase_sso_provider_id" uuid NOT NULL,
  "name" character varying(128) NOT NULL,
  "primary_domain" character varying(253) NOT NULL,
  "group_claim_name" character varying(128) DEFAULT 'groups'::character varying NOT NULL,
  "auto_create_members" boolean DEFAULT true NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_sso_providers_pkey" PRIMARY KEY (sso_provider_id)
);
CREATE TABLE IF NOT EXISTS kortix."account_tokens" (
  "token_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "name" character varying(255) NOT NULL,
  "public_key" character varying(64) NOT NULL,
  "secret_key_hash" character varying(128) NOT NULL,
  "status" kortix.api_key_status DEFAULT 'active'::kortix.api_key_status NOT NULL,
  "expires_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "project_id" uuid,
  CONSTRAINT "account_tokens_pkey" PRIMARY KEY (token_id)
);
CREATE TABLE IF NOT EXISTS kortix."audit_events" (
  "event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
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
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY (event_id)
);
CREATE TABLE IF NOT EXISTS kortix."audit_webhooks" (
  "webhook_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "url" text NOT NULL,
  "secret" text NOT NULL,
  "name" character varying(128) NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "action_prefix" character varying(128),
  "last_delivered_at" timestamp with time zone,
  "last_error_at" timestamp with time zone,
  "last_error" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audit_webhooks_pkey" PRIMARY KEY (webhook_id)
);
CREATE TABLE IF NOT EXISTS kortix."change_requests" (
  "cr_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "number" integer NOT NULL,
  "title" text NOT NULL,
  "description" text DEFAULT ''::text NOT NULL,
  "base_ref" text NOT NULL,
  "head_ref" text NOT NULL,
  "status" kortix.change_request_status DEFAULT 'open'::kortix.change_request_status NOT NULL,
  "head_commit_sha" text,
  "base_commit_sha" text,
  "origin_session_id" text,
  "created_by" uuid NOT NULL,
  "merged_at" timestamp with time zone,
  "merged_by" uuid,
  "merge_commit_sha" text,
  "closed_at" timestamp with time zone,
  "closed_by" uuid,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "change_requests_pkey" PRIMARY KEY (cr_id)
);
CREATE TABLE IF NOT EXISTS kortix."chat_channel_bindings" (
  "binding_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid,
  "platform" character varying(32) NOT NULL,
  "workspace_id" character varying(128) NOT NULL,
  "installed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "channel_id" character varying(128) NOT NULL,
  "channel_name" character varying(256),
  "channel_type" character varying(32),
  "picker_ts" character varying(64),
  "agent_model" character varying(128),
  CONSTRAINT "chat_channel_bindings_pkey" PRIMARY KEY (binding_id)
);
CREATE TABLE IF NOT EXISTS kortix."chat_installs" (
  "install_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "platform" character varying(32) NOT NULL,
  "workspace_id" character varying(128) NOT NULL,
  "project_id" uuid NOT NULL,
  "connected_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chat_installs_pkey" PRIMARY KEY (install_id)
);
CREATE TABLE IF NOT EXISTS kortix."chat_threads" (
  "thread_row_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "platform" character varying(32) NOT NULL,
  "workspace_id" character varying(128) NOT NULL,
  "thread_id" character varying(256) NOT NULL,
  "session_id" text NOT NULL,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chat_threads_pkey" PRIMARY KEY (thread_row_id)
);
CREATE TABLE IF NOT EXISTS kortix."executor_connector_actions" (
  "action_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "connector_id" uuid NOT NULL,
  "path" character varying(512) NOT NULL,
  "name" character varying(255) NOT NULL,
  "description" text,
  "input_schema" jsonb,
  "output_schema" jsonb,
  "risk" kortix.executor_risk DEFAULT 'read'::kortix.executor_risk NOT NULL,
  "binding" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "executor_connector_actions_pkey" PRIMARY KEY (action_id)
);
CREATE TABLE IF NOT EXISTS kortix."executor_connector_grants" (
  "grant_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "connector_id" uuid NOT NULL,
  "principal_type" kortix.secret_grant_principal NOT NULL,
  "principal_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "executor_connector_grants_pkey" PRIMARY KEY (grant_id)
);
CREATE TABLE IF NOT EXISTS kortix."executor_connector_policies" (
  "policy_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "connector_id" uuid NOT NULL,
  "match" character varying(512) NOT NULL,
  "action" kortix.executor_policy_action NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "executor_connector_policies_pkey" PRIMARY KEY (policy_id)
);
CREATE TABLE IF NOT EXISTS kortix."executor_connectors" (
  "connector_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "slug" character varying(128) NOT NULL,
  "name" character varying(255) NOT NULL,
  "provider_type" kortix.executor_connector_provider NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "auth_secret" character varying(64),
  "manifest_hash" character varying(64),
  "status" kortix.executor_connector_status DEFAULT 'active'::kortix.executor_connector_status NOT NULL,
  "last_error" text,
  "last_synced_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "share_scope" kortix.secret_share_scope DEFAULT 'project'::kortix.secret_share_scope NOT NULL,
  "credential_mode" kortix.executor_credential_mode DEFAULT 'shared'::kortix.executor_credential_mode NOT NULL,
  CONSTRAINT "executor_connectors_pkey" PRIMARY KEY (connector_id)
);
CREATE TABLE IF NOT EXISTS kortix."executor_credentials" (
  "credential_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "connector_id" uuid NOT NULL,
  "user_id" uuid,
  "kind" character varying(32) DEFAULT 'secret'::character varying NOT NULL,
  "value_enc" text NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "executor_credentials_pkey" PRIMARY KEY (credential_id)
);
CREATE TABLE IF NOT EXISTS kortix."executor_executions" (
  "execution_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "connector_id" uuid,
  "action_path" character varying(512) NOT NULL,
  "acting_user_id" uuid,
  "session_id" uuid,
  "status" kortix.executor_execution_status NOT NULL,
  "risk" kortix.executor_risk,
  "request_digest" character varying(64),
  "result_summary" jsonb,
  "approved_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "executor_executions_pkey" PRIMARY KEY (execution_id)
);
CREATE TABLE IF NOT EXISTS kortix."executor_project_policies" (
  "policy_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "match" character varying(512) NOT NULL,
  "action" kortix.executor_policy_action NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "executor_project_policies_pkey" PRIMARY KEY (policy_id)
);
CREATE TABLE IF NOT EXISTS kortix."executor_project_settings" (
  "project_id" uuid NOT NULL,
  "default_mode" kortix.executor_default_mode DEFAULT 'allow_all'::kortix.executor_default_mode NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "executor_project_settings_pkey" PRIMARY KEY (project_id)
);
CREATE TABLE IF NOT EXISTS kortix."legacy_sandbox_migrations" (
  "migration_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "run_id" text NOT NULL,
  "sandbox_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "project_id" uuid,
  "session_id" text,
  "status" character varying(32) DEFAULT 'planned'::character varying NOT NULL,
  "mode" character varying(32) DEFAULT 'dry_run'::character varying NOT NULL,
  "plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "rollback" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "applied_at" timestamp with time zone,
  "verified_at" timestamp with time zone,
  "rolled_back_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "phase" character varying(32),
  "progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "heartbeat_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "opencode_archive" text,
  CONSTRAINT "legacy_sandbox_migrations_mode_check" CHECK (((mode)::text = ANY ((ARRAY['dry_run'::character varying, 'apply'::character varying, 'verify'::character varying, 'rollback'::character varying])::text[]))),
  CONSTRAINT "legacy_sandbox_migrations_status_check" CHECK (((status)::text = ANY ((ARRAY['planned'::character varying, 'running'::character varying, 'applied'::character varying, 'verified'::character varying, 'completed'::character varying, 'rolled_back'::character varying, 'failed'::character varying])::text[]))),
  CONSTRAINT "legacy_sandbox_migrations_pkey" PRIMARY KEY (migration_id)
);
CREATE TABLE IF NOT EXISTS kortix."oauth_access_tokens" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "token_hash" character varying(128) NOT NULL,
  "client_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "scopes" jsonb DEFAULT '[]'::jsonb,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_access_tokens_pkey" PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS kortix."oauth_authorization_codes" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "code" character varying(128) NOT NULL,
  "client_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "redirect_uri" text NOT NULL,
  "scopes" jsonb DEFAULT '[]'::jsonb,
  "code_challenge" text NOT NULL,
  "code_challenge_method" character varying(10) DEFAULT 'S256'::character varying NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_authorization_codes_pkey" PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS kortix."oauth_clients" (
  "client_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "client_secret_hash" character varying(128) NOT NULL,
  "name" character varying(255) NOT NULL,
  "redirect_uris" jsonb DEFAULT '[]'::jsonb,
  "scopes" jsonb DEFAULT '[]'::jsonb,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_clients_pkey" PRIMARY KEY (client_id)
);
CREATE TABLE IF NOT EXISTS kortix."oauth_refresh_tokens" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "token_hash" character varying(128) NOT NULL,
  "access_token_id" uuid NOT NULL,
  "client_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_refresh_tokens_pkey" PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS kortix."project_git_connections" (
  "connection_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "provider" character varying(32) NOT NULL,
  "repo_url" text NOT NULL,
  "repo_owner" character varying(255),
  "repo_name" character varying(255),
  "external_repo_id" text,
  "default_branch" character varying(255) DEFAULT 'main'::character varying NOT NULL,
  "auth_method" character varying(64) NOT NULL,
  "installation_id" text,
  "credential_ref" text,
  "permissions" jsonb DEFAULT '{}'::jsonb,
  "visibility" character varying(32),
  "webhook_id" text,
  "status" character varying(32) DEFAULT 'connected'::character varying NOT NULL,
  "last_validated_at" timestamp with time zone,
  "last_error_code" character varying(64),
  "last_error_message" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_git_connections_pkey" PRIMARY KEY (connection_id)
);
CREATE TABLE IF NOT EXISTS kortix."project_git_credentials" (
  "credential_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "provider" character varying(32) NOT NULL,
  "auth_method" character varying(64) DEFAULT 'token'::character varying NOT NULL,
  "value_enc" text NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_git_credentials_pkey" PRIMARY KEY (credential_id)
);
CREATE TABLE IF NOT EXISTS kortix."project_group_grants" (
  "project_id" uuid NOT NULL,
  "group_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "role" kortix.project_role DEFAULT 'viewer'::kortix.project_role NOT NULL,
  "granted_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  CONSTRAINT "project_group_grants_pk" PRIMARY KEY (project_id, group_id)
);
CREATE TABLE IF NOT EXISTS kortix."project_members" (
  "account_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "project_role" kortix.project_role DEFAULT 'viewer'::kortix.project_role NOT NULL,
  "granted_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone
);
CREATE TABLE IF NOT EXISTS kortix."project_secret_grants" (
  "grant_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "secret_id" uuid NOT NULL,
  "principal_type" kortix.secret_grant_principal NOT NULL,
  "principal_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_secret_grants_pkey" PRIMARY KEY (grant_id)
);
CREATE TABLE IF NOT EXISTS kortix."project_secrets" (
  "secret_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "name" character varying(64) NOT NULL,
  "value_enc" text NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "share_scope" kortix.secret_share_scope DEFAULT 'project'::kortix.secret_share_scope NOT NULL,
  "owner_user_id" uuid,
  "active" boolean DEFAULT true NOT NULL,
  "scope" kortix.project_secret_scope DEFAULT 'runtime'::kortix.project_secret_scope NOT NULL,
  CONSTRAINT "project_secrets_pkey" PRIMARY KEY (secret_id)
);
CREATE TABLE IF NOT EXISTS kortix."project_session_grants" (
  "grant_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "session_id" text NOT NULL,
  "principal_type" kortix.secret_grant_principal NOT NULL,
  "principal_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_session_grants_pkey" PRIMARY KEY (grant_id)
);
CREATE TABLE IF NOT EXISTS kortix."project_sessions" (
  "session_id" text NOT NULL,
  "account_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "branch_name" text NOT NULL,
  "base_ref" text DEFAULT 'main'::text NOT NULL,
  "sandbox_provider" kortix.sandbox_provider DEFAULT 'daytona'::kortix.sandbox_provider NOT NULL,
  "sandbox_id" text,
  "sandbox_url" text,
  "opencode_session_id" text,
  "agent_name" text DEFAULT 'default'::text NOT NULL,
  "status" kortix.project_session_status DEFAULT 'queued'::kortix.project_session_status NOT NULL,
  "error" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "visibility" kortix.project_session_visibility DEFAULT 'private'::kortix.project_session_visibility NOT NULL,
  CONSTRAINT "project_sessions_pkey" PRIMARY KEY (session_id)
);
CREATE TABLE IF NOT EXISTS kortix."project_snapshot_builds" (
  "build_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "commit_sha" text NOT NULL,
  "branch" text DEFAULT ''::text NOT NULL,
  "snapshot_name" text NOT NULL,
  "content_hash" text NOT NULL,
  "status" text NOT NULL,
  "error" text,
  "error_category" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "project_snapshot_builds_status_check" CHECK ((status = ANY (ARRAY['building'::text, 'ready'::text, 'failed'::text]))),
  CONSTRAINT "project_snapshot_builds_pkey" PRIMARY KEY (build_id)
);
CREATE TABLE IF NOT EXISTS kortix."project_trigger_runtime" (
  "project_id" uuid NOT NULL,
  "slug" character varying(128) NOT NULL,
  "last_fired_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_trigger_runtime_pkey" PRIMARY KEY (project_id, slug)
);
CREATE TABLE IF NOT EXISTS kortix."projects" (
  "project_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "name" character varying(255) NOT NULL,
  "repo_url" text NOT NULL,
  "default_branch" character varying(255) DEFAULT 'main'::character varying NOT NULL,
  "manifest_path" text DEFAULT 'kortix.toml'::text NOT NULL,
  "status" kortix.project_status DEFAULT 'active'::kortix.project_status NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "last_opened_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "projects_pkey" PRIMARY KEY (project_id)
);
CREATE TABLE IF NOT EXISTS kortix."sandbox_compute_sessions" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "sandbox_id" uuid NOT NULL,
  "session_id" text,
  "actor_user_id" uuid,
  "cpu_cores" integer NOT NULL,
  "memory_gb" integer NOT NULL,
  "disk_gb" integer NOT NULL,
  "gpu_count" integer DEFAULT 0 NOT NULL,
  "state" text DEFAULT 'active'::text NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  "last_billed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cost_usd" numeric(12,6) DEFAULT 0 NOT NULL,
  "ledger_id" uuid,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sandbox_compute_sessions_state_check" CHECK ((state = ANY (ARRAY['active'::text, 'stopped'::text, 'finalized'::text]))),
  CONSTRAINT "sandbox_compute_sessions_pkey" PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS kortix."sandbox_templates" (
  "template_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid,
  "account_id" uuid,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "is_shared" boolean DEFAULT false NOT NULL,
  "source" text DEFAULT 'toml'::text NOT NULL,
  "provider" text DEFAULT 'daytona'::text NOT NULL,
  "image" text,
  "dockerfile_path" text,
  "entrypoint" text,
  "cpu" integer,
  "memory_gb" integer,
  "disk_gb" integer,
  "content_hash" text,
  "provider_snapshot_name" text,
  "provider_state" text DEFAULT 'missing'::text NOT NULL,
  "last_built_at" timestamp with time zone,
  "last_error" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sandbox_templates_pkey" PRIMARY KEY (template_id)
);
CREATE TABLE IF NOT EXISTS kortix."scim_tokens" (
  "token_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "name" character varying(128) NOT NULL,
  "secret_hash" text NOT NULL,
  "public_prefix" character varying(32) NOT NULL,
  "last_used_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  CONSTRAINT "scim_tokens_pkey" PRIMARY KEY (token_id)
);
CREATE TABLE IF NOT EXISTS kortix."service_accounts" (
  "service_account_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "name" character varying(128) NOT NULL,
  "description" text,
  "secret_hash" text NOT NULL,
  "public_prefix" character varying(32) NOT NULL,
  "status" character varying(16) DEFAULT 'active'::character varying NOT NULL,
  "last_used_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "disabled_at" timestamp with time zone,
  "disabled_by" uuid,
  CONSTRAINT "service_accounts_pkey" PRIMARY KEY (service_account_id)
);
CREATE TABLE IF NOT EXISTS kortix."session_sandboxes" (
  "sandbox_id" uuid NOT NULL,
  "session_id" text NOT NULL,
  "account_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "provider" kortix.sandbox_provider DEFAULT 'daytona'::kortix.sandbox_provider NOT NULL,
  "external_id" text,
  "base_url" text,
  "status" kortix.session_sandbox_status DEFAULT 'provisioning'::kortix.session_sandbox_status NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "session_sandboxes_pkey" PRIMARY KEY (sandbox_id),
  CONSTRAINT "session_sandboxes_session_id_key" UNIQUE (session_id)
);
CREATE TABLE IF NOT EXISTS kortix."stripe_webhook_events_processed" (
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "processed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stripe_webhook_events_processed_pkey" PRIMARY KEY (event_id)
);
CREATE TABLE IF NOT EXISTS kortix."usage_events" (
  "event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
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
  "cost_usd" numeric(12,6) DEFAULT 0 NOT NULL,
  "streaming" boolean DEFAULT false NOT NULL,
  "upstream_status" integer,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "usage_events_pkey" PRIMARY KEY (event_id)
);
CREATE TABLE IF NOT EXISTS kortix."vault_item_grants" (
  "item_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vault_item_grants_pkey" PRIMARY KEY (item_id, user_id)
);
CREATE TABLE IF NOT EXISTS kortix."vault_items" (
  "item_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "kind" kortix.vault_item_kind DEFAULT 'env'::kortix.vault_item_kind NOT NULL,
  "name" character varying(128) NOT NULL,
  "value_enc" text NOT NULL,
  "owner_user_id" uuid,
  "provider_id" character varying(64),
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vault_items_pkey" PRIMARY KEY (item_id)
);
CREATE TABLE IF NOT EXISTS kortix."yolo_member_tokens" (
  "user_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "token_prefix" character varying(16) NOT NULL,
  "token_hash" character varying(128) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "yolo_member_tokens_pkey" PRIMARY KEY (user_id, account_id)
);

-- ---- foreign keys (65) ----
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_github_installation_states_account_id_fkey' AND conrelid='kortix.account_github_installation_states'::regclass) THEN
    ALTER TABLE kortix."account_github_installation_states" ADD CONSTRAINT "account_github_installation_states_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_github_installations_account_id_fkey' AND conrelid='kortix.account_github_installations'::regclass) THEN
    ALTER TABLE kortix."account_github_installations" ADD CONSTRAINT "account_github_installations_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_group_members_group_id_fkey' AND conrelid='kortix.account_group_members'::regclass) THEN
    ALTER TABLE kortix."account_group_members" ADD CONSTRAINT "account_group_members_group_id_fkey" FOREIGN KEY (group_id) REFERENCES kortix.account_groups(group_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_groups_account_id_fkey' AND conrelid='kortix.account_groups'::regclass) THEN
    ALTER TABLE kortix."account_groups" ADD CONSTRAINT "account_groups_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_invitations_account_id_fkey' AND conrelid='kortix.account_invitations'::regclass) THEN
    ALTER TABLE kortix."account_invitations" ADD CONSTRAINT "account_invitations_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_session_activity_account_id_fkey' AND conrelid='kortix.account_session_activity'::regclass) THEN
    ALTER TABLE kortix."account_session_activity" ADD CONSTRAINT "account_session_activity_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_sso_group_mappings_account_id_fkey' AND conrelid='kortix.account_sso_group_mappings'::regclass) THEN
    ALTER TABLE kortix."account_sso_group_mappings" ADD CONSTRAINT "account_sso_group_mappings_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_sso_group_mappings_sso_provider_id_fkey' AND conrelid='kortix.account_sso_group_mappings'::regclass) THEN
    ALTER TABLE kortix."account_sso_group_mappings" ADD CONSTRAINT "account_sso_group_mappings_sso_provider_id_fkey" FOREIGN KEY (sso_provider_id) REFERENCES kortix.account_sso_providers(sso_provider_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_sso_group_mappings_group_id_fkey' AND conrelid='kortix.account_sso_group_mappings'::regclass) THEN
    ALTER TABLE kortix."account_sso_group_mappings" ADD CONSTRAINT "account_sso_group_mappings_group_id_fkey" FOREIGN KEY (group_id) REFERENCES kortix.account_groups(group_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_sso_providers_account_id_fkey' AND conrelid='kortix.account_sso_providers'::regclass) THEN
    ALTER TABLE kortix."account_sso_providers" ADD CONSTRAINT "account_sso_providers_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_tokens_project_id_fkey' AND conrelid='kortix.account_tokens'::regclass) THEN
    ALTER TABLE kortix."account_tokens" ADD CONSTRAINT "account_tokens_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_tokens_account_id_fkey' AND conrelid='kortix.account_tokens'::regclass) THEN
    ALTER TABLE kortix."account_tokens" ADD CONSTRAINT "account_tokens_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='audit_events_account_id_fkey' AND conrelid='kortix.audit_events'::regclass) THEN
    ALTER TABLE kortix."audit_events" ADD CONSTRAINT "audit_events_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='audit_webhooks_account_id_fkey' AND conrelid='kortix.audit_webhooks'::regclass) THEN
    ALTER TABLE kortix."audit_webhooks" ADD CONSTRAINT "audit_webhooks_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='change_requests_account_id_fkey' AND conrelid='kortix.change_requests'::regclass) THEN
    ALTER TABLE kortix."change_requests" ADD CONSTRAINT "change_requests_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='change_requests_project_id_fkey' AND conrelid='kortix.change_requests'::regclass) THEN
    ALTER TABLE kortix."change_requests" ADD CONSTRAINT "change_requests_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='change_requests_origin_session_id_fkey' AND conrelid='kortix.change_requests'::regclass) THEN
    ALTER TABLE kortix."change_requests" ADD CONSTRAINT "change_requests_origin_session_id_fkey" FOREIGN KEY (origin_session_id) REFERENCES kortix.project_sessions(session_id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chat_channel_bindings_project_id_fkey' AND conrelid='kortix.chat_channel_bindings'::regclass) THEN
    ALTER TABLE kortix."chat_channel_bindings" ADD CONSTRAINT "chat_channel_bindings_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chat_installs_project_id_fkey' AND conrelid='kortix.chat_installs'::regclass) THEN
    ALTER TABLE kortix."chat_installs" ADD CONSTRAINT "chat_installs_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chat_threads_project_id_fkey' AND conrelid='kortix.chat_threads'::regclass) THEN
    ALTER TABLE kortix."chat_threads" ADD CONSTRAINT "chat_threads_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chat_threads_session_id_fkey' AND conrelid='kortix.chat_threads'::regclass) THEN
    ALTER TABLE kortix."chat_threads" ADD CONSTRAINT "chat_threads_session_id_fkey" FOREIGN KEY (session_id) REFERENCES kortix.project_sessions(session_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='executor_connector_actions_connector_id_fkey' AND conrelid='kortix.executor_connector_actions'::regclass) THEN
    ALTER TABLE kortix."executor_connector_actions" ADD CONSTRAINT "executor_connector_actions_connector_id_fkey" FOREIGN KEY (connector_id) REFERENCES kortix.executor_connectors(connector_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='executor_connector_grants_connector_id_fkey' AND conrelid='kortix.executor_connector_grants'::regclass) THEN
    ALTER TABLE kortix."executor_connector_grants" ADD CONSTRAINT "executor_connector_grants_connector_id_fkey" FOREIGN KEY (connector_id) REFERENCES kortix.executor_connectors(connector_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='executor_connector_policies_connector_id_fkey' AND conrelid='kortix.executor_connector_policies'::regclass) THEN
    ALTER TABLE kortix."executor_connector_policies" ADD CONSTRAINT "executor_connector_policies_connector_id_fkey" FOREIGN KEY (connector_id) REFERENCES kortix.executor_connectors(connector_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='executor_connectors_account_id_fkey' AND conrelid='kortix.executor_connectors'::regclass) THEN
    ALTER TABLE kortix."executor_connectors" ADD CONSTRAINT "executor_connectors_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='executor_connectors_project_id_fkey' AND conrelid='kortix.executor_connectors'::regclass) THEN
    ALTER TABLE kortix."executor_connectors" ADD CONSTRAINT "executor_connectors_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='executor_credentials_connector_id_fkey' AND conrelid='kortix.executor_credentials'::regclass) THEN
    ALTER TABLE kortix."executor_credentials" ADD CONSTRAINT "executor_credentials_connector_id_fkey" FOREIGN KEY (connector_id) REFERENCES kortix.executor_connectors(connector_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='executor_executions_account_id_fkey' AND conrelid='kortix.executor_executions'::regclass) THEN
    ALTER TABLE kortix."executor_executions" ADD CONSTRAINT "executor_executions_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='executor_executions_project_id_fkey' AND conrelid='kortix.executor_executions'::regclass) THEN
    ALTER TABLE kortix."executor_executions" ADD CONSTRAINT "executor_executions_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='executor_executions_connector_id_fkey' AND conrelid='kortix.executor_executions'::regclass) THEN
    ALTER TABLE kortix."executor_executions" ADD CONSTRAINT "executor_executions_connector_id_fkey" FOREIGN KEY (connector_id) REFERENCES kortix.executor_connectors(connector_id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='executor_project_policies_project_id_fkey' AND conrelid='kortix.executor_project_policies'::regclass) THEN
    ALTER TABLE kortix."executor_project_policies" ADD CONSTRAINT "executor_project_policies_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='executor_project_settings_project_id_fkey' AND conrelid='kortix.executor_project_settings'::regclass) THEN
    ALTER TABLE kortix."executor_project_settings" ADD CONSTRAINT "executor_project_settings_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='oauth_access_tokens_client_id_oauth_clients_client_id_fk' AND conrelid='kortix.oauth_access_tokens'::regclass) THEN
    ALTER TABLE kortix."oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY (client_id) REFERENCES kortix.oauth_clients(client_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='oauth_authorization_codes_client_id_oauth_clients_client_id_fk' AND conrelid='kortix.oauth_authorization_codes'::regclass) THEN
    ALTER TABLE kortix."oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_client_id_oauth_clients_client_id_fk" FOREIGN KEY (client_id) REFERENCES kortix.oauth_clients(client_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='oauth_refresh_tokens_access_token_id_oauth_access_tokens_id_fk' AND conrelid='kortix.oauth_refresh_tokens'::regclass) THEN
    ALTER TABLE kortix."oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_access_token_id_oauth_access_tokens_id_fk" FOREIGN KEY (access_token_id) REFERENCES kortix.oauth_access_tokens(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='oauth_refresh_tokens_client_id_oauth_clients_client_id_fk' AND conrelid='kortix.oauth_refresh_tokens'::regclass) THEN
    ALTER TABLE kortix."oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY (client_id) REFERENCES kortix.oauth_clients(client_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_git_connections_account_id_fkey' AND conrelid='kortix.project_git_connections'::regclass) THEN
    ALTER TABLE kortix."project_git_connections" ADD CONSTRAINT "project_git_connections_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_git_connections_project_id_fkey' AND conrelid='kortix.project_git_connections'::regclass) THEN
    ALTER TABLE kortix."project_git_connections" ADD CONSTRAINT "project_git_connections_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_git_credentials_account_id_fkey' AND conrelid='kortix.project_git_credentials'::regclass) THEN
    ALTER TABLE kortix."project_git_credentials" ADD CONSTRAINT "project_git_credentials_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_git_credentials_project_id_fkey' AND conrelid='kortix.project_git_credentials'::regclass) THEN
    ALTER TABLE kortix."project_git_credentials" ADD CONSTRAINT "project_git_credentials_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_group_grants_project_id_fkey' AND conrelid='kortix.project_group_grants'::regclass) THEN
    ALTER TABLE kortix."project_group_grants" ADD CONSTRAINT "project_group_grants_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_group_grants_group_id_fkey' AND conrelid='kortix.project_group_grants'::regclass) THEN
    ALTER TABLE kortix."project_group_grants" ADD CONSTRAINT "project_group_grants_group_id_fkey" FOREIGN KEY (group_id) REFERENCES kortix.account_groups(group_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_group_grants_account_id_fkey' AND conrelid='kortix.project_group_grants'::regclass) THEN
    ALTER TABLE kortix."project_group_grants" ADD CONSTRAINT "project_group_grants_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_members_account_id_fkey' AND conrelid='kortix.project_members'::regclass) THEN
    ALTER TABLE kortix."project_members" ADD CONSTRAINT "project_members_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_members_project_id_fkey' AND conrelid='kortix.project_members'::regclass) THEN
    ALTER TABLE kortix."project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_secret_grants_secret_id_fkey' AND conrelid='kortix.project_secret_grants'::regclass) THEN
    ALTER TABLE kortix."project_secret_grants" ADD CONSTRAINT "project_secret_grants_secret_id_fkey" FOREIGN KEY (secret_id) REFERENCES kortix.project_secrets(secret_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_secrets_project_id_fkey' AND conrelid='kortix.project_secrets'::regclass) THEN
    ALTER TABLE kortix."project_secrets" ADD CONSTRAINT "project_secrets_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_session_grants_session_id_fkey' AND conrelid='kortix.project_session_grants'::regclass) THEN
    ALTER TABLE kortix."project_session_grants" ADD CONSTRAINT "project_session_grants_session_id_fkey" FOREIGN KEY (session_id) REFERENCES kortix.project_sessions(session_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_sessions_account_id_fkey' AND conrelid='kortix.project_sessions'::regclass) THEN
    ALTER TABLE kortix."project_sessions" ADD CONSTRAINT "project_sessions_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_sessions_project_id_fkey' AND conrelid='kortix.project_sessions'::regclass) THEN
    ALTER TABLE kortix."project_sessions" ADD CONSTRAINT "project_sessions_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_snapshot_builds_account_id_fkey' AND conrelid='kortix.project_snapshot_builds'::regclass) THEN
    ALTER TABLE kortix."project_snapshot_builds" ADD CONSTRAINT "project_snapshot_builds_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_snapshot_builds_project_id_fkey' AND conrelid='kortix.project_snapshot_builds'::regclass) THEN
    ALTER TABLE kortix."project_snapshot_builds" ADD CONSTRAINT "project_snapshot_builds_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_trigger_runtime_project_id_fkey' AND conrelid='kortix.project_trigger_runtime'::regclass) THEN
    ALTER TABLE kortix."project_trigger_runtime" ADD CONSTRAINT "project_trigger_runtime_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='projects_account_id_fkey' AND conrelid='kortix.projects'::regclass) THEN
    ALTER TABLE kortix."projects" ADD CONSTRAINT "projects_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sandbox_compute_sessions_account_id_fkey' AND conrelid='kortix.sandbox_compute_sessions'::regclass) THEN
    ALTER TABLE kortix."sandbox_compute_sessions" ADD CONSTRAINT "sandbox_compute_sessions_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sandbox_compute_sessions_ledger_id_fkey' AND conrelid='kortix.sandbox_compute_sessions'::regclass) THEN
    ALTER TABLE kortix."sandbox_compute_sessions" ADD CONSTRAINT "sandbox_compute_sessions_ledger_id_fkey" FOREIGN KEY (ledger_id) REFERENCES kortix.credit_ledger(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sandbox_templates_account_id_fkey' AND conrelid='kortix.sandbox_templates'::regclass) THEN
    ALTER TABLE kortix."sandbox_templates" ADD CONSTRAINT "sandbox_templates_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sandbox_templates_project_id_fkey' AND conrelid='kortix.sandbox_templates'::regclass) THEN
    ALTER TABLE kortix."sandbox_templates" ADD CONSTRAINT "sandbox_templates_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='scim_tokens_account_id_fkey' AND conrelid='kortix.scim_tokens'::regclass) THEN
    ALTER TABLE kortix."scim_tokens" ADD CONSTRAINT "scim_tokens_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='service_accounts_account_id_fkey' AND conrelid='kortix.service_accounts'::regclass) THEN
    ALTER TABLE kortix."service_accounts" ADD CONSTRAINT "service_accounts_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='usage_events_account_id_fkey' AND conrelid='kortix.usage_events'::regclass) THEN
    ALTER TABLE kortix."usage_events" ADD CONSTRAINT "usage_events_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='usage_events_project_id_fkey' AND conrelid='kortix.usage_events'::regclass) THEN
    ALTER TABLE kortix."usage_events" ADD CONSTRAINT "usage_events_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vault_item_grants_item_id_fkey' AND conrelid='kortix.vault_item_grants'::regclass) THEN
    ALTER TABLE kortix."vault_item_grants" ADD CONSTRAINT "vault_item_grants_item_id_fkey" FOREIGN KEY (item_id) REFERENCES kortix.vault_items(item_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vault_items_project_id_fkey' AND conrelid='kortix.vault_items'::regclass) THEN
    ALTER TABLE kortix."vault_items" ADD CONSTRAINT "vault_items_project_id_fkey" FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='yolo_member_tokens_account_id_fkey' AND conrelid='kortix.yolo_member_tokens'::regclass) THEN
    ALTER TABLE kortix."yolo_member_tokens" ADD CONSTRAINT "yolo_member_tokens_account_id_fkey" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;

-- ---- indexes (130) ----
CREATE INDEX IF NOT EXISTS idx_account_github_installation_states_account ON kortix.account_github_installation_states USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_account_github_installation_states_expires_at ON kortix.account_github_installation_states USING btree (expires_at);
CREATE INDEX IF NOT EXISTS idx_account_github_installations_owner ON kortix.account_github_installations USING btree (owner_login);
CREATE INDEX IF NOT EXISTS idx_account_github_installations_account ON kortix.account_github_installations USING btree (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_github_installations_account_installation ON kortix.account_github_installations USING btree (account_id, installation_id);
CREATE INDEX IF NOT EXISTS idx_account_group_members_user ON kortix.account_group_members USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_account_groups_account ON kortix.account_groups USING btree (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_groups_account_name ON kortix.account_groups USING btree (account_id, name);
CREATE INDEX IF NOT EXISTS idx_account_invitations_email ON kortix.account_invitations USING btree (email);
CREATE INDEX IF NOT EXISTS idx_account_invitations_account ON kortix.account_invitations USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_account_invitations_expires_at ON kortix.account_invitations USING btree (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_invitations_pending ON kortix.account_invitations USING btree (account_id, email);
CREATE INDEX IF NOT EXISTS idx_account_session_activity_account ON kortix.account_session_activity USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_account_session_activity_user ON kortix.account_session_activity USING btree (account_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_sso_mappings_claim ON kortix.account_sso_group_mappings USING btree (account_id, claim_value);
CREATE INDEX IF NOT EXISTS idx_account_sso_mappings_provider ON kortix.account_sso_group_mappings USING btree (sso_provider_id);
CREATE INDEX IF NOT EXISTS idx_account_sso_mappings_group ON kortix.account_sso_group_mappings USING btree (group_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_sso_providers_account ON kortix.account_sso_providers USING btree (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_sso_providers_supabase ON kortix.account_sso_providers USING btree (supabase_sso_provider_id);
CREATE INDEX IF NOT EXISTS idx_account_sso_providers_domain ON kortix.account_sso_providers USING btree (primary_domain);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_tokens_public_key ON kortix.account_tokens USING btree (public_key);
CREATE INDEX IF NOT EXISTS idx_account_tokens_secret_hash ON kortix.account_tokens USING btree (secret_key_hash);
CREATE INDEX IF NOT EXISTS idx_account_tokens_account ON kortix.account_tokens USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_account_tokens_user ON kortix.account_tokens USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_account_tokens_project ON kortix.account_tokens USING btree (project_id) WHERE (project_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_events_account_time ON kortix.audit_events USING btree (account_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_time ON kortix.audit_events USING btree (actor_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_resource ON kortix.audit_events USING btree (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_webhooks_account ON kortix.audit_webhooks USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_audit_webhooks_enabled ON kortix.audit_webhooks USING btree (account_id, enabled);
CREATE INDEX IF NOT EXISTS idx_change_requests_account ON kortix.change_requests USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_change_requests_project ON kortix.change_requests USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_change_requests_project_status ON kortix.change_requests USING btree (project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_change_requests_project_number ON kortix.change_requests USING btree (project_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_channel_bindings_channel ON kortix.chat_channel_bindings USING btree (platform, workspace_id, channel_id);
CREATE INDEX IF NOT EXISTS idx_chat_channel_bindings_project ON kortix.chat_channel_bindings USING btree (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_installs_workspace_project ON kortix.chat_installs USING btree (platform, workspace_id, project_id);
CREATE INDEX IF NOT EXISTS idx_chat_installs_workspace ON kortix.chat_installs USING btree (platform, workspace_id);
CREATE INDEX IF NOT EXISTS idx_chat_installs_project ON kortix.chat_installs USING btree (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_threads_thread ON kortix.chat_threads USING btree (platform, workspace_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_project ON kortix.chat_threads USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_session ON kortix.chat_threads USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_executor_connector_actions_connector ON kortix.executor_connector_actions USING btree (connector_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_executor_connector_actions_path ON kortix.executor_connector_actions USING btree (connector_id, path);
CREATE INDEX IF NOT EXISTS idx_executor_connector_grants_connector ON kortix.executor_connector_grants USING btree (connector_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_executor_connector_grants_unique ON kortix.executor_connector_grants USING btree (connector_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS idx_executor_connector_policies_connector ON kortix.executor_connector_policies USING btree (connector_id);
CREATE INDEX IF NOT EXISTS idx_executor_connectors_project ON kortix.executor_connectors USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_executor_connectors_account ON kortix.executor_connectors USING btree (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_executor_connectors_project_slug ON kortix.executor_connectors USING btree (project_id, slug);
CREATE INDEX IF NOT EXISTS idx_executor_credentials_connector ON kortix.executor_credentials USING btree (connector_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_executor_credentials_connector_user ON kortix.executor_credentials USING btree (connector_id, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_executor_executions_project ON kortix.executor_executions USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_executor_executions_connector ON kortix.executor_executions USING btree (connector_id);
CREATE INDEX IF NOT EXISTS idx_executor_executions_status ON kortix.executor_executions USING btree (status);
CREATE INDEX IF NOT EXISTS idx_executor_project_policies_project ON kortix.executor_project_policies USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_legacy_sandbox_migrations_run ON kortix.legacy_sandbox_migrations USING btree (run_id);
CREATE INDEX IF NOT EXISTS idx_legacy_sandbox_migrations_sandbox ON kortix.legacy_sandbox_migrations USING btree (sandbox_id);
CREATE INDEX IF NOT EXISTS idx_legacy_sandbox_migrations_status ON kortix.legacy_sandbox_migrations USING btree (status);
CREATE INDEX IF NOT EXISTS idx_legacy_sandbox_migrations_account ON kortix.legacy_sandbox_migrations USING btree (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_sandbox_migrations_active_sandbox ON kortix.legacy_sandbox_migrations USING btree (sandbox_id) WHERE ((status)::text = ANY ((ARRAY['planned'::character varying, 'running'::character varying, 'applied'::character varying, 'verified'::character varying, 'completed'::character varying])::text[]));
-- heartbeat_at index is created in 00000000000101_legacy_migration_durable.sql after the column is added
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_access_token_hash ON kortix.oauth_access_tokens USING btree (token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_client ON kortix.oauth_access_tokens USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_user ON kortix.oauth_access_tokens USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_codes_code ON kortix.oauth_authorization_codes USING btree (code);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON kortix.oauth_authorization_codes USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON kortix.oauth_authorization_codes USING btree (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_refresh_token_hash ON kortix.oauth_refresh_tokens USING btree (token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_client ON kortix.oauth_refresh_tokens USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_project_git_connections_account ON kortix.project_git_connections USING btree (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_git_connections_project ON kortix.project_git_connections USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_project_git_connections_provider_repo ON kortix.project_git_connections USING btree (provider, external_repo_id);
CREATE INDEX IF NOT EXISTS idx_project_git_connections_status ON kortix.project_git_connections USING btree (status);
CREATE INDEX IF NOT EXISTS idx_project_git_credentials_account ON kortix.project_git_credentials USING btree (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_git_credentials_project_provider ON kortix.project_git_credentials USING btree (project_id, provider);
CREATE INDEX IF NOT EXISTS idx_project_group_grants_expires_at ON kortix.project_group_grants USING btree (expires_at) WHERE (expires_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_project_group_grants_project ON kortix.project_group_grants USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_project_group_grants_group ON kortix.project_group_grants USING btree (group_id);
CREATE INDEX IF NOT EXISTS idx_project_group_grants_account ON kortix.project_group_grants USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_project_members_account_user ON kortix.project_members USING btree (account_id, user_id);
CREATE INDEX IF NOT EXISTS idx_project_members_project ON kortix.project_members USING btree (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_members_project_user ON kortix.project_members USING btree (project_id, user_id);
CREATE INDEX IF NOT EXISTS idx_project_members_expires_at ON kortix.project_members USING btree (expires_at) WHERE (expires_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_project_secret_grants_secret ON kortix.project_secret_grants USING btree (secret_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_secret_grants_unique ON kortix.project_secret_grants USING btree (secret_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS idx_project_secrets_project ON kortix.project_secrets USING btree (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_secrets_project_name_shared ON kortix.project_secrets USING btree (project_id, name) WHERE (owner_user_id IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_secrets_project_name_owner ON kortix.project_secrets USING btree (project_id, name, owner_user_id) WHERE (owner_user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_project_session_grants_session ON kortix.project_session_grants USING btree (session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_session_grants_unique ON kortix.project_session_grants USING btree (session_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS idx_project_sessions_account ON kortix.project_sessions USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_project_sessions_project ON kortix.project_sessions USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_project_sessions_status ON kortix.project_sessions USING btree (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_sessions_project_branch ON kortix.project_sessions USING btree (project_id, branch_name);
CREATE INDEX IF NOT EXISTS idx_project_sessions_created_by ON kortix.project_sessions USING btree (created_by);
CREATE INDEX IF NOT EXISTS idx_project_snapshot_builds_project_recent ON kortix.project_snapshot_builds USING btree (project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_snapshot_builds_status ON kortix.project_snapshot_builds USING btree (project_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_account ON kortix.projects USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON kortix.projects USING btree (status);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON kortix.projects USING btree (updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_account_repo ON kortix.projects USING btree (account_id, repo_url);
CREATE INDEX IF NOT EXISTS idx_sandbox_compute_sessions_account_time ON kortix.sandbox_compute_sessions USING btree (account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sandbox_compute_sessions_open ON kortix.sandbox_compute_sessions USING btree (sandbox_id) WHERE (ended_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_sandbox_compute_sessions_last_billed ON kortix.sandbox_compute_sessions USING btree (last_billed_at) WHERE (state = 'active'::text);
CREATE INDEX IF NOT EXISTS idx_sandbox_templates_project ON kortix.sandbox_templates USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_sandbox_templates_shared ON kortix.sandbox_templates USING btree (is_shared);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_templates_project_slug ON kortix.sandbox_templates USING btree (project_id, slug);
CREATE INDEX IF NOT EXISTS idx_scim_tokens_account ON kortix.scim_tokens USING btree (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scim_tokens_secret_hash ON kortix.scim_tokens USING btree (secret_hash);
CREATE INDEX IF NOT EXISTS idx_service_accounts_account ON kortix.service_accounts USING btree (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_accounts_secret_hash ON kortix.service_accounts USING btree (secret_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_accounts_account_name ON kortix.service_accounts USING btree (account_id, name);
CREATE INDEX IF NOT EXISTS idx_session_sandboxes_session ON kortix.session_sandboxes USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_session_sandboxes_project ON kortix.session_sandboxes USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_session_sandboxes_account ON kortix.session_sandboxes USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_session_sandboxes_status ON kortix.session_sandboxes USING btree (status);
CREATE INDEX IF NOT EXISTS idx_session_sandboxes_external_id ON kortix.session_sandboxes USING btree (external_id);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_processed_at ON kortix.stripe_webhook_events_processed USING btree (processed_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_account_time ON kortix.usage_events USING btree (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_project_time ON kortix.usage_events USING btree (project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_session ON kortix.usage_events USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_model ON kortix.usage_events USING btree (provider, model);
CREATE INDEX IF NOT EXISTS idx_vault_item_grants_user ON kortix.vault_item_grants USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_vault_items_project ON kortix.vault_items USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_vault_items_owner_user ON kortix.vault_items USING btree (owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_items_project_shared_name ON kortix.vault_items USING btree (project_id, name) WHERE (owner_user_id IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_items_project_private_name ON kortix.vault_items USING btree (project_id, owner_user_id, name) WHERE (owner_user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_yolo_member_tokens_prefix ON kortix.yolo_member_tokens USING btree (token_prefix) WHERE (revoked_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_yolo_member_tokens_account ON kortix.yolo_member_tokens USING btree (account_id);

-- ---- new columns on existing tables (17) ----
ALTER TABLE kortix."account_deletion_requests" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
ALTER TABLE kortix."account_deletion_requests" ADD COLUMN IF NOT EXISTS "scheduled_for" timestamp with time zone;  -- REVIEW: NOT NULL in target, no default; left NULLABLE to avoid failing on existing rows.
ALTER TABLE kortix."account_deletion_requests" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending'::text NOT NULL;
ALTER TABLE kortix."account_members" ADD COLUMN IF NOT EXISTS "is_super_admin" boolean DEFAULT false NOT NULL;
ALTER TABLE kortix."account_members" ADD COLUMN IF NOT EXISTS "scim_external_id" text;
ALTER TABLE kortix."accounts" ADD COLUMN IF NOT EXISTS "mfa_required" boolean DEFAULT false NOT NULL;
ALTER TABLE kortix."accounts" ADD COLUMN IF NOT EXISTS "pat_idle_revoke_days" integer;
ALTER TABLE kortix."accounts" ADD COLUMN IF NOT EXISTS "pat_max_lifetime_days" integer;
ALTER TABLE kortix."accounts" ADD COLUMN IF NOT EXISTS "pat_require_expiry" boolean DEFAULT false NOT NULL;
ALTER TABLE kortix."accounts" ADD COLUMN IF NOT EXISTS "session_idle_timeout_minutes" integer;
ALTER TABLE kortix."accounts" ADD COLUMN IF NOT EXISTS "session_max_lifetime_minutes" integer;
ALTER TABLE kortix."credit_accounts" ADD COLUMN IF NOT EXISTS "auto_topup_consecutive_failures" integer DEFAULT 0 NOT NULL;
ALTER TABLE kortix."credit_accounts" ADD COLUMN IF NOT EXISTS "auto_topup_customized" boolean DEFAULT false NOT NULL;
ALTER TABLE kortix."credit_accounts" ADD COLUMN IF NOT EXISTS "auto_topup_disabled_reason" text;
ALTER TABLE kortix."credit_accounts" ADD COLUMN IF NOT EXISTS "billing_model" text DEFAULT 'legacy'::text NOT NULL;
ALTER TABLE kortix."credit_accounts" ADD COLUMN IF NOT EXISTS "seat_count" integer DEFAULT 1 NOT NULL;
ALTER TABLE kortix."credit_accounts" ADD COLUMN IF NOT EXISTS "seat_subscription_item_id" text;

