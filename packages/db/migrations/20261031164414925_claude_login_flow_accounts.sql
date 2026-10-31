-- Migration: claude_login_flow_accounts
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- A Claude sign-in now adds a named Claude account to the project's provider
-- accounts (kortix.account_secret_resources), like a ChatGPT sign-in. The flow
-- row carries what the completion writes: the project, the label, the account
-- id (minted at start, or the account a reconnect refreshes) and the sharing.
-- Additive, nullable columns plus one boolean with a constant default (no table
-- rewrite) on a small table of short-lived rows. Old code ignores them.

ALTER TABLE "kortix"."claude_subscription_login_flows" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."claude_subscription_login_flows" ADD COLUMN "resource_label" text;--> statement-breakpoint
ALTER TABLE "kortix"."claude_subscription_login_flows" ADD COLUMN "resource_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."claude_subscription_login_flows" ADD COLUMN "reconnect" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."claude_subscription_login_flows" ADD COLUMN "sharing" jsonb;