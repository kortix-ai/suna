-- Migration: pooled_provider_secrets
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEW THE GENERATED SQL BELOW. drizzle-kit writes it from the diff between
-- kortix.ts and the snapshot; it knows the target shape, not how to reach it
-- without downtime. Check the same list `migrate:create` prints:
--   [ ] Bare NOT NULL added to an existing populated table (needs a backfill first).
--   [ ] Plain CREATE INDEX / DROP INDEX on an EXISTING table -- move it to
--       `pnpm migrate:create <slug> --concurrent`; it blocks writes here.
--   [ ] New FK/constraint on an existing table -- add NOT VALID, VALIDATE after.
--   [ ] A DROP/RENAME/ALTER ... TYPE the generator proposed from a STALE
--       snapshot. Delete anything already applied by an earlier migration.
--   [ ] Any DROP/RENAME/ALTER ... TYPE/DROP NOT NULL needs the enforced line:
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

CREATE TABLE "kortix"."account_secret_grants" (
	"secret_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"granted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_secret_grants_secret_id_user_id_pk" PRIMARY KEY("secret_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "kortix"."account_secret_resources" (
	"secret_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"label" varchar(100) NOT NULL,
	"provider_id" varchar(100),
	"name" varchar(64) NOT NULL,
	"value_enc" text NOT NULL,
	"consumer" "kortix"."project_secret_consumer" NOT NULL,
	"strategy" "kortix"."project_secret_strategy" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"cooldown_until" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_secret_resources_account_identity" UNIQUE("secret_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "kortix"."session_provider_secret_pools" (
	"session_id" text NOT NULL,
	"provider_id" varchar(100) NOT NULL,
	"secret_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_index" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_provider_secret_pools_session_id_provider_id_pk" PRIMARY KEY("session_id","provider_id")
);
--> statement-breakpoint
ALTER TABLE "kortix"."account_secret_grants" ADD CONSTRAINT "account_secret_grants_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_secret_grants" ADD CONSTRAINT "account_secret_grants_member_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "kortix"."account_memberships"("user_id","account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_secret_grants" ADD CONSTRAINT "account_secret_grants_resource_fk" FOREIGN KEY ("secret_id","account_id") REFERENCES "kortix"."account_secret_resources"("secret_id","account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_secret_resources" ADD CONSTRAINT "account_secret_resources_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_provider_secret_pools" ADD CONSTRAINT "session_provider_pools_session_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_secret_grants_member" ON "kortix"."account_secret_grants" USING btree ("account_id","user_id");--> statement-breakpoint
CREATE INDEX "account_secret_resources_account_provider" ON "kortix"."account_secret_resources" USING btree ("account_id","provider_id");

--> statement-breakpoint
ALTER TABLE kortix.account_secret_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE kortix.account_secret_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE kortix.session_provider_secret_pools ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON kortix.account_secret_resources, kortix.account_secret_grants, kortix.session_provider_secret_pools FROM anon, authenticated;
