-- Migration: pi_private_storage_access
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

ALTER TABLE "kortix"."filesystem_blobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."filesystem_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."filesystems" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."pi_runtime_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."session_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."session_worker_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- These API-owned tables inherit browser-role grants from the baseline.
-- Remove those grants. RLS remains enabled with no policies to deny rows if
-- another migration later restores blanket grants. The API table owner and
-- service_role retain access; FORCE RLS would break owner-based deployments.
REVOKE ALL ON TABLE "kortix"."session_worker_log" FROM anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."pi_runtime_artifacts" FROM anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."session_attachments" FROM anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."filesystems" FROM anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."filesystem_files" FROM anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."filesystem_blobs" FROM anon, authenticated;
--> statement-breakpoint
