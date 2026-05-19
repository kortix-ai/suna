CREATE TYPE "kortix"."chat_platform" AS ENUM('slack');--> statement-breakpoint
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
CREATE TABLE "kortix"."chat_installations" (
	"installation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"platform" "kortix"."chat_platform" NOT NULL,
	"workspace_id" varchar(128) NOT NULL,
	"workspace_name" varchar(256),
	"bot_user_id" varchar(128),
	"bot_token_enc" text NOT NULL,
	"signing_secret_enc" text,
	"scopes" text,
	"installed_by" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
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
ALTER TABLE "kortix"."chat_channel_bindings" ADD CONSTRAINT "chat_channel_bindings_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."chat_installations" ADD CONSTRAINT "chat_installations_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."chat_threads" ADD CONSTRAINT "chat_threads_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."chat_threads" ADD CONSTRAINT "chat_threads_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_channel_bindings_project_slug" ON "kortix"."chat_channel_bindings" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "idx_chat_channel_bindings_lookup" ON "kortix"."chat_channel_bindings" USING btree ("platform","workspace_id","channel_id");--> statement-breakpoint
CREATE INDEX "idx_chat_installations_account" ON "kortix"."chat_installations" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_installations_account_platform_workspace" ON "kortix"."chat_installations" USING btree ("account_id","platform","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_threads_thread" ON "kortix"."chat_threads" USING btree ("platform","workspace_id","thread_id");--> statement-breakpoint
CREATE INDEX "idx_chat_threads_project" ON "kortix"."chat_threads" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_chat_threads_session" ON "kortix"."chat_threads" USING btree ("session_id");