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
CREATE INDEX "idx_suna_account_migrations_status" ON "kortix"."suna_account_migrations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_suna_account_migrations_account" ON "kortix"."suna_account_migrations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_suna_account_migrations_heartbeat" ON "kortix"."suna_account_migrations" USING btree ("status","heartbeat_at");