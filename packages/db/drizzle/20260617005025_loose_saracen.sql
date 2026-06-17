CREATE TYPE "kortix"."session_lifecycle_command_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'dead_lettered');--> statement-breakpoint
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
ALTER TABLE "kortix"."project_session_public_shares" ADD CONSTRAINT "project_session_public_shares_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_public_shares" ADD CONSTRAINT "project_session_public_shares_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_public_shares" ADD CONSTRAINT "project_session_public_shares_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_lifecycle_commands" ADD CONSTRAINT "session_lifecycle_commands_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_lifecycle_commands" ADD CONSTRAINT "session_lifecycle_commands_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."session_lifecycle_commands" ADD CONSTRAINT "session_lifecycle_commands_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_session_public_shares_token_hash" ON "kortix"."project_session_public_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_project_session_public_shares_session" ON "kortix"."project_session_public_shares" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_project_session_public_shares_project" ON "kortix"."project_session_public_shares" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_session_lifecycle_commands_idempotency" ON "kortix"."session_lifecycle_commands" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_session_lifecycle_commands_due" ON "kortix"."session_lifecycle_commands" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "idx_session_lifecycle_commands_project" ON "kortix"."session_lifecycle_commands" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_session_lifecycle_commands_session" ON "kortix"."session_lifecycle_commands" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_session_lifecycle_commands_locked" ON "kortix"."session_lifecycle_commands" USING btree ("locked_until");