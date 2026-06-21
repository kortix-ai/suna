-- Kortix-native account/project management.
--
-- This migration makes the account invitation and Git-backed project model
-- durable for environments that run SQL migrations without drizzle-kit push,
-- and adds the v1 user-level project ACL that future group permissions can
-- build on.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'project_status'
  ) THEN
    CREATE TYPE "kortix"."project_status" AS ENUM ('active', 'archived');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'project_session_status'
  ) THEN
    CREATE TYPE "kortix"."project_session_status" AS ENUM (
      'queued',
      'branching',
      'provisioning',
      'running',
      'stopped',
      'failed',
      'completed'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'project_snapshot_status'
  ) THEN
    CREATE TYPE "kortix"."project_snapshot_status" AS ENUM (
      'queued',
      'building',
      'ready',
      'failed'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'project_role'
  ) THEN
    CREATE TYPE "kortix"."project_role" AS ENUM (
      'manager',
      'editor',
      'viewer'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'session_sandbox_status'
  ) THEN
    CREATE TYPE "kortix"."session_sandbox_status" AS ENUM (
      'provisioning',
      'active',
      'stopped',
      'error',
      'archived'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "kortix"."account_invitations" (
  "invite_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade,
  "email" varchar(255) NOT NULL,
  "invited_by" uuid,
  "initial_role" "kortix"."account_role" DEFAULT 'member' NOT NULL,
  "accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone DEFAULT (now() + interval '14 days') NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_account_invitations_email" ON "kortix"."account_invitations" USING btree ("email");
CREATE INDEX IF NOT EXISTS "idx_account_invitations_account" ON "kortix"."account_invitations" USING btree ("account_id");
CREATE INDEX IF NOT EXISTS "idx_account_invitations_expires_at" ON "kortix"."account_invitations" USING btree ("expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_invitations_pending" ON "kortix"."account_invitations" USING btree ("account_id", "email");

CREATE TABLE IF NOT EXISTS "kortix"."projects" (
  "project_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade,
  "name" varchar(255) NOT NULL,
  "repo_url" text NOT NULL,
  "default_branch" varchar(255) DEFAULT 'main' NOT NULL,
  "manifest_path" text DEFAULT 'kortix.toml' NOT NULL,
  "status" "kortix"."project_status" DEFAULT 'active' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "last_opened_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_projects_account" ON "kortix"."projects" USING btree ("account_id");
CREATE INDEX IF NOT EXISTS "idx_projects_status" ON "kortix"."projects" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_projects_updated" ON "kortix"."projects" USING btree ("updated_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_projects_account_repo" ON "kortix"."projects" USING btree ("account_id", "repo_url");

CREATE TABLE IF NOT EXISTS "kortix"."project_members" (
  "account_id" uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade,
  "project_id" uuid NOT NULL REFERENCES "kortix"."projects"("project_id") ON DELETE cascade,
  "user_id" uuid NOT NULL,
  "project_role" "kortix"."project_role" DEFAULT 'viewer' NOT NULL,
  "granted_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_project_members_account_user" ON "kortix"."project_members" USING btree ("account_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_project_members_project" ON "kortix"."project_members" USING btree ("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_project_members_project_user" ON "kortix"."project_members" USING btree ("project_id", "user_id");

CREATE TABLE IF NOT EXISTS "kortix"."project_sessions" (
  "session_id" text PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade,
  "project_id" uuid NOT NULL REFERENCES "kortix"."projects"("project_id") ON DELETE cascade,
  "branch_name" text NOT NULL,
  "base_ref" text DEFAULT 'main' NOT NULL,
  "sandbox_provider" "kortix"."sandbox_provider" DEFAULT 'daytona' NOT NULL,
  "sandbox_id" text,
  "sandbox_url" text,
  "opencode_session_id" text,
  "agent_name" text DEFAULT 'default' NOT NULL,
  "status" "kortix"."project_session_status" DEFAULT 'queued' NOT NULL,
  "error" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_project_sessions_account" ON "kortix"."project_sessions" USING btree ("account_id");
CREATE INDEX IF NOT EXISTS "idx_project_sessions_project" ON "kortix"."project_sessions" USING btree ("project_id");
CREATE INDEX IF NOT EXISTS "idx_project_sessions_status" ON "kortix"."project_sessions" USING btree ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_project_sessions_project_branch" ON "kortix"."project_sessions" USING btree ("project_id", "branch_name");

CREATE TABLE IF NOT EXISTS "kortix"."session_sandboxes" (
  "sandbox_id" uuid PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL UNIQUE,
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
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_session_sandboxes_session" ON "kortix"."session_sandboxes" USING btree ("session_id");
CREATE INDEX IF NOT EXISTS "idx_session_sandboxes_project" ON "kortix"."session_sandboxes" USING btree ("project_id");
CREATE INDEX IF NOT EXISTS "idx_session_sandboxes_account" ON "kortix"."session_sandboxes" USING btree ("account_id");
CREATE INDEX IF NOT EXISTS "idx_session_sandboxes_status" ON "kortix"."session_sandboxes" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_session_sandboxes_external_id" ON "kortix"."session_sandboxes" USING btree ("external_id");

CREATE TABLE IF NOT EXISTS "kortix"."project_runtime_snapshots" (
  "snapshot_row_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade,
  "project_id" uuid NOT NULL REFERENCES "kortix"."projects"("project_id") ON DELETE cascade,
  "provider" "kortix"."sandbox_provider" DEFAULT 'daytona' NOT NULL,
  "commit_sha" text NOT NULL,
  "snapshot_id" text,
  "status" "kortix"."project_snapshot_status" DEFAULT 'queued' NOT NULL,
  "error" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_project_runtime_snapshots_project" ON "kortix"."project_runtime_snapshots" USING btree ("project_id");
CREATE INDEX IF NOT EXISTS "idx_project_runtime_snapshots_status" ON "kortix"."project_runtime_snapshots" USING btree ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_project_runtime_snapshots_commit_provider" ON "kortix"."project_runtime_snapshots" USING btree ("project_id", "commit_sha", "provider");

GRANT ALL ON TABLE
  "kortix"."account_invitations",
  "kortix"."projects",
  "kortix"."project_members",
  "kortix"."project_sessions",
  "kortix"."session_sandboxes",
  "kortix"."project_runtime_snapshots"
TO service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE
  "kortix"."account_invitations",
  "kortix"."projects",
  "kortix"."project_members",
  "kortix"."project_sessions",
  "kortix"."session_sandboxes",
  "kortix"."project_runtime_snapshots"
TO authenticated;

GRANT SELECT ON TABLE
  "kortix"."account_invitations",
  "kortix"."projects",
  "kortix"."project_members",
  "kortix"."project_sessions",
  "kortix"."session_sandboxes",
  "kortix"."project_runtime_snapshots"
TO anon;
