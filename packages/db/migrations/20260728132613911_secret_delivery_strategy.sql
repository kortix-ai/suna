-- Migration: secret_delivery_strategy
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Stage 1 of the Secret Delivery Strategy (docs/SECRET_DELIVERY_STRATEGY_PLAN.md):
-- the storage a project secret needs before its plaintext value can stop being
-- injected into the sandbox environment.
--
-- Today every granted project secret is written into the sandbox's process env,
-- and the agent runs as the same uid as the daemon with NOPASSWD:ALL sudo -- so
-- `env`, /proc/<pid>/environ and /dev/shm/kortix/agent-env.sh all read it back
-- (docs/ENV_SECRET_EXPOSURE_BASELINE.md). Enforcement cannot live inside the
-- box; `strategy` is the column the SERVER consults to decide whether the value
-- ever leaves it, and project_session_secret_handles is what the sandbox holds
-- instead when it does not.
--
-- NOTHING CHANGES BEHAVIOURALLY ON APPLY. Both new strategy columns default to
-- 'runtime', which is exactly today's delivery, so every existing row resolves
-- as before and buildSessionSandboxEnvVars returns a byte-identical env map.
-- There is no backfill and no flag day: a project changes behaviour only when
-- someone explicitly flips a secret. Nothing reads these columns yet.
--
-- Purely additive:
--   [x] Two brand-new enum TYPES -- CREATE TYPE, not ALTER TYPE ... ADD VALUE,
--       so the faked-baseline enum-drift class (the sandbox_provider "platinum"
--       22P02 incident) cannot apply.
--   [x] Every ADD COLUMN is nullable, or NOT NULL WITH a default -- metadata-only
--       on modern Postgres, no table rewrite, no backfill.
--   [x] The new table is created empty in this same transaction, so its three FK
--       constraints validate against zero rows and hold no lock anything else is
--       waiting on. Its indexes are NOT here: they ship separately as
--       20260728132613912_secret_delivery_indexes.concurrent.ts, because index
--       creation cannot run inside this batch transaction.
--   [x] No DROP, no rename, no type change -- an old app version running against
--       this schema neither sees nor needs any of it.
--
-- The FK constraint names below are shortened from what drizzle-kit emitted:
-- the generated `..._session_id_project_sessions_session_id_fk` form is 72 bytes
-- and Postgres silently truncates identifiers at 63, which would leave the DB
-- holding a name no migration file contains. Same convention as
-- 20260727135415063_connection_policies.sql.

CREATE TYPE "kortix"."project_secret_handle_status" AS ENUM('active', 'superseded', 'revoked');--> statement-breakpoint
CREATE TYPE "kortix"."project_secret_strategy" AS ENUM('runtime', 'egress', 'broker', 'denied');--> statement-breakpoint
CREATE TABLE "kortix"."project_session_secret_handles" (
	"handle_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"identifier" varchar(128) NOT NULL,
	"env_name" varchar(64) NOT NULL,
	"lookup_id" varchar(32) NOT NULL,
	"handle_hash" varchar(64) NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"status" "kortix"."project_secret_handle_status" DEFAULT 'active' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_secrets" ADD COLUMN "strategy" "kortix"."project_secret_strategy" DEFAULT 'runtime' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."project_secrets" ADD COLUMN "egress_policy" jsonb;--> statement-breakpoint
ALTER TABLE "kortix"."project_secrets" ADD COLUMN "handle_prefix" varchar(48);--> statement-breakpoint
ALTER TABLE "kortix"."project_secrets" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "kortix"."project_secrets" ADD COLUMN "rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."project_secrets" ADD COLUMN "strategy_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."projects" ADD COLUMN "secret_default_strategy" "kortix"."project_secret_strategy" DEFAULT 'runtime' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_secret_handles" ADD CONSTRAINT "project_session_secret_handles_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_secret_handles" ADD CONSTRAINT "project_session_secret_handles_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_secret_handles" ADD CONSTRAINT "project_session_secret_handles_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "kortix"."project_secrets"("secret_id") ON DELETE cascade ON UPDATE no action;

-- A non-'runtime' strategy with no policy is not a narrower secret, it is an
-- unusable one: the broker has no host to match and no slot to inject into, so
-- the row's own DDL would be asserting a delivery it cannot perform. Added here,
-- while every row is still 'runtime' and the check validates against zero
-- violations -- after real rows exist this becomes a validating ALTER.
-- NOT VALID so adding it neither scans project_secrets nor blocks writes; it is
-- enforced for every INSERT/UPDATE from this moment on, which is the part that
-- matters. The scan is deferred to VALIDATE CONSTRAINT in the sibling
-- non-transactional migration, where it takes only SHARE UPDATE EXCLUSIVE.
alter table "kortix"."project_secrets"
  add constraint "project_secrets_egress_policy_required"
  check ("strategy" = 'runtime' or "egress_policy" is not null) not valid;
