-- Migration: permission_push_claims
--
-- One push per agent permission ask (session, request id) across every API
-- replica. The dedupe was an in-process Map, so on a multi-task deploy a
-- repeated relay reached a task that had not seen it and pushed again (release
-- gate PROJ-38, v0.13.52). A new empty table: the FK takes a brief
-- SHARE ROW EXCLUSIVE lock on project_sessions under the 2 s lock_timeout.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEW THE GENERATED SQL BELOW. drizzle-kit writes it from the diff between
-- kortix.ts and the snapshot; it knows the target shape, not how to reach it
-- without downtime. Check the same list `migrate:create` prints:
--   [ ] Bare NOT NULL added to an existing populated table (needs a backfill first).
--   [ ] Plain CREATE INDEX / DROP INDEX on an EXISTING table -- move it to
--       `pnpm migrate:create <slug> --concurrent`; it blocks writes here.
--   [ ] New FK/constraint on an existing table -- add NOT VALID, VALIDATE after.
--   [ ] A DROP/RENAME/ALTER ... TYPE the generator proposed from a STALE
--       snapshot. Delete anything already applied by an earlier migration.
--   [ ] Any DROP/RENAME/ALTER ... TYPE/DROP NOT NULL needs the enforced line:
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

CREATE TABLE "kortix"."permission_push_claims" (
	"session_id" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_push_claims_session_id_request_id_pk" PRIMARY KEY("session_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "kortix"."permission_push_claims" ADD CONSTRAINT "permission_push_claims_session_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;