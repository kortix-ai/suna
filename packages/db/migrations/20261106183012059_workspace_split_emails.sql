-- Migration: workspace_split_emails
--
-- Workspaces C9 (design: .agents/skills/learnings/work/workspaces/design.md
-- §3.2 C9). The outbox of the split's owner email: one row per (source
-- account, owner), unique on idempotency_key
-- `workspace-split-email:<from_account_id>:<user_id>`. The split enqueues the
-- rows when an account's last move is done, in apply mode only; the leader
-- tick (workspaces/split/owner-email.ts) claims a due row under a lease, sends
-- it, and records the result. A failed send retries with backoff up to 5
-- attempts; a `sending` row whose lease expired (the process died mid-send)
-- is claimed again. The rows before this table lived in
-- workspace_split_runs.plan->'owner_emails'; no environment ran an apply
-- with that shape (Release 1 has not shipped), so nothing moves.
--
-- Snapshot: drizzle-kit also proposed the columns of
-- 20261106153430000_account_tokens_key_scopes.sql,
-- 20261106153440000_accounts_pat_allow_no_expiry.sql,
-- 20261106153450000_oauth_access_tokens_bound_workspace.sql and
-- 20261106153460000_oauth_codes_refresh_bound_workspace.sql (hand-written,
-- the snapshot never had them). Those files add them; this file does not.
-- The snapshot committed with this file records them, so schema-sync is
-- green again.
--
-- Locks: a new table and its two indexes only. Nothing else is touched.
--
-- Mixed-version deploy: the old image never names the table.
--
-- ROLL BACK: no down migration (repo policy). The table can stay: only the new
-- image reads it.
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE TABLE "kortix"."workspace_split_emails" (
	"email_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"from_account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_split_emails_state_check" CHECK ("kortix"."workspace_split_emails"."state" IN ('pending', 'sending', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."workspace_split_emails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_split_emails_idempotency_key" ON "kortix"."workspace_split_emails" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_workspace_split_emails_due" ON "kortix"."workspace_split_emails" USING btree ("state","next_attempt_at");
