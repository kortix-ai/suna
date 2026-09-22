-- Migration: agent_session_on_behalf_of
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

ALTER TABLE "kortix"."account_tokens" ADD COLUMN "on_behalf_of_user_id" uuid;--> statement-breakpoint
-- The human an agent-session token acts on behalf of (spec
-- docs/specs/2026-09-22-agents-as-principals.md §2.3). Deleting that human
-- clears it, so a session never keeps personal-resource reach for a user who
-- no longer exists. NOT VALID: every existing row is NULL, so there is nothing
-- to validate, and a VALIDATE scan here would hold the ACCESS EXCLUSIVE lock
-- the ADD COLUMN above already took on a table every authenticated request
-- reads. New and updated rows are checked from this point on.
ALTER TABLE "kortix"."account_tokens" ADD CONSTRAINT "account_tokens_on_behalf_of_user_fk"
  FOREIGN KEY ("on_behalf_of_user_id") REFERENCES auth.users(id) ON DELETE SET NULL NOT VALID;
