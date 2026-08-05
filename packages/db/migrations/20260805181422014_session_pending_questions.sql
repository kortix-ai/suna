-- Migration: session_pending_questions
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Both indexes below are on a table CREATED IN THIS FILE, so they build on an
-- empty relation and cannot block writes — the `--concurrent` escape hatch is
-- for indexing an EXISTING table. Same shape as
-- 20260802202200473_executor_attachments.sql.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- NOTE: drizzle-kit also emitted an `ALTER TABLE kortix.credit_accounts ADD
-- COLUMN enterprise_entitled ...` here. That column is already added by
-- 20260805030712000_enterprise_entitled_flag.sql; the snapshot was simply stale,
-- so the generator re-proposed it. Removed — re-applying it would fail on a DB
-- that already ran that migration. The regenerated snapshot committed alongside
-- this file records the column correctly, which is what closes the drift.

CREATE TABLE "kortix"."session_pending_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"request_id" text NOT NULL,
	"opencode_session_id" text,
	"questions" jsonb NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"answers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "session_pending_questions_session_request_uniq" ON "kortix"."session_pending_questions" USING btree ("session_id","request_id");--> statement-breakpoint
CREATE INDEX "session_pending_questions_open_idx" ON "kortix"."session_pending_questions" USING btree ("session_id") WHERE answered_at IS NULL;