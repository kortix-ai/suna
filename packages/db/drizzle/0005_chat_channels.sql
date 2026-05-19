CREATE TYPE "kortix"."change_request_status" AS ENUM('open', 'merged', 'closed');--> statement-breakpoint
CREATE TYPE "kortix"."chat_platform" AS ENUM('slack');--> statement-breakpoint
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
	"revoked_at" timestamp with time zone
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
	"project_id" uuid NOT NULL,
	"slug" varchar(128) NOT NULL,
	"platform" "kortix"."chat_platform" NOT NULL,
	"workspace_id" varchar(128) NOT NULL,
	"channel_id" varchar(128) NOT NULL,
	"channel_name" varchar(256),
	"last_manifest_sha" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."chat_threads" (
	"row_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" "kortix"."chat_platform" NOT NULL,
	"workspace_id" varchar(128) NOT NULL,
	"channel_id" varchar(128) NOT NULL,
	"thread_id" varchar(256) NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text,
	"channel_slug" varchar(128) NOT NULL,
	"opened_by" varchar(256),
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_runtime_snapshots" ADD COLUMN "branch" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."account_tokens" ADD CONSTRAINT "account_tokens_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."account_tokens" ADD CONSTRAINT "account_tokens_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."change_requests" ADD CONSTRAINT "change_requests_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."change_requests" ADD CONSTRAINT "change_requests_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."change_requests" ADD CONSTRAINT "change_requests_origin_session_id_project_sessions_session_id_fk" FOREIGN KEY ("origin_session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."chat_channel_bindings" ADD CONSTRAINT "chat_channel_bindings_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."chat_threads" ADD CONSTRAINT "chat_threads_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."chat_threads" ADD CONSTRAINT "chat_threads_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_tokens_public_key" ON "kortix"."account_tokens" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "idx_account_tokens_secret_hash" ON "kortix"."account_tokens" USING btree ("secret_key_hash");--> statement-breakpoint
CREATE INDEX "idx_account_tokens_account" ON "kortix"."account_tokens" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_account_tokens_user" ON "kortix"."account_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_account_tokens_project" ON "kortix"."account_tokens" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_change_requests_account" ON "kortix"."change_requests" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_change_requests_project" ON "kortix"."change_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_change_requests_project_status" ON "kortix"."change_requests" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_change_requests_project_number" ON "kortix"."change_requests" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_channel_bindings_project_slug" ON "kortix"."chat_channel_bindings" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "idx_chat_channel_bindings_lookup" ON "kortix"."chat_channel_bindings" USING btree ("platform","workspace_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_threads_thread" ON "kortix"."chat_threads" USING btree ("platform","workspace_id","thread_id");--> statement-breakpoint
CREATE INDEX "idx_chat_threads_project" ON "kortix"."chat_threads" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_chat_threads_session" ON "kortix"."chat_threads" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_project_runtime_snapshots_branch_ready" ON "kortix"."project_runtime_snapshots" USING btree ("project_id","branch","status","created_at");
