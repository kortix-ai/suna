CREATE TABLE "kortix"."teams_pending_uploads" (
	"upload_id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"service_url" text NOT NULL,
	"conversation_id" text NOT NULL,
	"bot_id" varchar(128),
	"filename" text NOT NULL,
	"content_type" varchar(128),
	"content_base64" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."chat_turn_streams" ADD COLUMN "channel_ref" jsonb;--> statement-breakpoint
CREATE INDEX "idx_teams_pending_uploads_expiry" ON "kortix"."teams_pending_uploads" USING btree ("expires_at");