ALTER TABLE "kortix"."chat_channel_bindings"
ADD COLUMN IF NOT EXISTS "conversation_policy" varchar(32) DEFAULT 'project_open' NOT NULL;
--> statement-breakpoint
ALTER TABLE "kortix"."chat_channel_bindings"
ALTER COLUMN "conversation_policy" SET DEFAULT 'project_open';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kortix"."chat_thread_participants" (
  "participant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "platform" varchar(32) NOT NULL,
  "workspace_id" varchar(128) NOT NULL,
  "thread_id" varchar(256) NOT NULL,
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
DO $$ BEGIN
 ALTER TABLE "kortix"."chat_thread_participants"
 ADD CONSTRAINT "chat_thread_participants_session_id_fkey"
 FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_chat_thread_participants_thread_user"
ON "kortix"."chat_thread_participants" USING btree ("platform","workspace_id","thread_id","platform_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_thread_participants_session"
ON "kortix"."chat_thread_participants" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_thread_participants_user"
ON "kortix"."chat_thread_participants" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kortix"."chat_pending_auth_messages" (
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
ALTER TABLE "kortix"."chat_pending_auth_messages"
ADD COLUMN IF NOT EXISTS "slack_response_url" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kortix"."chat_pending_auth_messages"
 ADD CONSTRAINT "chat_pending_auth_messages_project_id_fkey"
 FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_pending_auth_messages_lookup"
ON "kortix"."chat_pending_auth_messages" USING btree ("workspace_id","platform_user_id","expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_pending_auth_messages_expiry"
ON "kortix"."chat_pending_auth_messages" USING btree ("expires_at");
