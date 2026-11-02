-- Migration: claude_subscription_logins
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Two new tables for Claude subscription logins (Claude Code through the
-- member's own Claude plan):
--   * claude_subscription_logins: one encrypted `claude setup-token` token per
--     (account, user). Only the API's privileged connection reads it, to give it
--     to Claude Code in that user's sessions.
--   * claude_subscription_login_flows: one row per login run in Kortix, so a
--     complete call on any replica reaches the replica that runs the process.
-- New, empty tables: no backfill, no lock on a populated table except the brief
-- FK validation lock on account_memberships, which has no rows to scan here.
-- RLS on with no policy, and the client roles revoked: browsers never read them.

CREATE TABLE "kortix"."claude_subscription_login_flows" (
	"flow_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"authorize_url" text,
	"code_enc" text,
	"error" text,
	"owner_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_subscription_login_flows_status_check" CHECK ("kortix"."claude_subscription_login_flows"."status" in ('starting', 'awaiting_code', 'exchanging', 'connected', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."claude_subscription_login_flows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kortix"."claude_subscription_logins" (
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"value_enc" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_subscription_logins_account_id_user_id_pk" PRIMARY KEY("account_id","user_id"),
	CONSTRAINT "claude_subscription_logins_source_check" CHECK ("kortix"."claude_subscription_logins"."source" in ('setup_token', 'pasted'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."claude_subscription_logins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."claude_subscription_login_flows" ADD CONSTRAINT "claude_subscription_login_flows_member_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "kortix"."account_memberships"("user_id","account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."claude_subscription_logins" ADD CONSTRAINT "claude_subscription_logins_member_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "kortix"."account_memberships"("user_id","account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_claude_subscription_login_flows_member" ON "kortix"."claude_subscription_login_flows" USING btree ("account_id","user_id");
--> statement-breakpoint
REVOKE ALL ON kortix.claude_subscription_logins FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON kortix.claude_subscription_login_flows FROM anon, authenticated;
