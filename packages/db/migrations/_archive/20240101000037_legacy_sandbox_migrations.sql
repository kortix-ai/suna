CREATE TABLE IF NOT EXISTS "kortix"."legacy_sandbox_migrations" (
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
  "error" text,
  "applied_at" timestamp with time zone,
  "verified_at" timestamp with time zone,
  "rolled_back_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "legacy_sandbox_migrations_status_check"
    CHECK ("status" IN ('planned', 'applied', 'verified', 'rolled_back', 'failed')),
  CONSTRAINT "legacy_sandbox_migrations_mode_check"
    CHECK ("mode" IN ('dry_run', 'apply', 'verify', 'rollback'))
);

CREATE INDEX IF NOT EXISTS "idx_legacy_sandbox_migrations_run"
  ON "kortix"."legacy_sandbox_migrations" USING btree ("run_id");

CREATE INDEX IF NOT EXISTS "idx_legacy_sandbox_migrations_sandbox"
  ON "kortix"."legacy_sandbox_migrations" USING btree ("sandbox_id");

CREATE INDEX IF NOT EXISTS "idx_legacy_sandbox_migrations_status"
  ON "kortix"."legacy_sandbox_migrations" USING btree ("status");

CREATE INDEX IF NOT EXISTS "idx_legacy_sandbox_migrations_account"
  ON "kortix"."legacy_sandbox_migrations" USING btree ("account_id");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_legacy_sandbox_migrations_active_sandbox"
  ON "kortix"."legacy_sandbox_migrations" USING btree ("sandbox_id")
  WHERE "status" IN ('applied', 'verified');
