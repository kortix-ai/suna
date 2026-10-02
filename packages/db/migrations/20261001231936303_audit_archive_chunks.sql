-- Migration: audit_archive_chunks
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

-- WHAT: one new table. CREATE TABLE takes no lock on any existing table.
-- WHY: the audit archive job (this PR) records which weeks of audit history it exported to S3, so a
--   reader knows when to serve a week from the archive and the job resumes after a crash.
-- mixed-version-safe: an added table; no existing code reads or writes it.
-- ROLL BACK: no down migration (repo policy). Switch the job off; the table stays empty.
CREATE TABLE "kortix"."audit_archive_chunks" (
	"week_start" date PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"row_count" bigint DEFAULT 0 NOT NULL,
	"legacy_row_count" bigint DEFAULT 0 NOT NULL,
	"object_count" integer DEFAULT 0 NOT NULL,
	"byte_count" bigint DEFAULT 0 NOT NULL,
	"manifest_key" text,
	"manifest_sha256" varchar(64),
	"retain_until" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
