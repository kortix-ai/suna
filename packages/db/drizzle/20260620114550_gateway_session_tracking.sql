CREATE TABLE IF NOT EXISTS "kortix"."warm_pool_presence" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."account_tokens" ADD COLUMN IF NOT EXISTS "agent_grant" jsonb;--> statement-breakpoint
ALTER TABLE "kortix"."account_tokens" ADD COLUMN IF NOT EXISTS "session_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."gateway_request_logs" ADD COLUMN IF NOT EXISTS "session_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_warm_pool_presence_seen" ON "kortix"."warm_pool_presence" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gateway_logs_session" ON "kortix"."gateway_request_logs" USING btree ("project_id","session_id");
