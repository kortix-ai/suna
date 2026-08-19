-- Migration: voice_join_links
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Short, ungessable join links that resolve server-side to a fresh LiveKit
-- access token -- see apps/api/src/channels/voice/join-links.ts. Replaces
-- handing the raw ~300-char LiveKit JWT itself out in `voice_spawn`'s
-- `join_url`: one corrupted character in transit breaks the JWT signature
-- and the browser gets "invalid token" with no way to retry.
--
-- `token_hash` (sha256 of the raw token) is the primary key, never the raw
-- token -- same posture as `project_session_public_shares.token_hash`: a DB
-- dump should not itself be a bag of live capability tokens.
--
-- Expand/contract checklist:
--   [x] CREATE TABLE only -- no existing table is touched, so no rewrite, no
--       backfill, and nothing to lock beyond the new relation.
--   [x] The index is built on the empty table in the same migration, so a
--       plain CREATE INDEX cannot block writes (nothing can write to a table
--       that did not exist a statement ago). The --concurrent escape hatch is
--       for indexes on populated tables and does not apply here.
--   [x] No FK to project_sessions or projects: a link can legitimately
--       outlive interest in its session row, and a cascade delete is not
--       worth the coupling for what is ultimately a disposable, short-TTL row.
--   [x] No DROP/RENAME/ALTER TYPE -- nothing for old code to trip over.

CREATE TABLE "kortix"."voice_join_links" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"call_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_voice_join_links_call" ON "kortix"."voice_join_links" USING btree ("call_id");