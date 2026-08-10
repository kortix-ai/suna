-- Migration: preserve_tunnel_audit_history
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

-- mixed-version-safe: old API versions only delete the parent connection; retaining child audit rows does not change their query or delete contract.
ALTER TABLE "kortix"."tunnel_audit_logs"
  DROP CONSTRAINT IF EXISTS "tunnel_audit_logs_tunnel_id_tunnel_connections_tunnel_id_fk";

COMMENT ON COLUMN "kortix"."tunnel_audit_logs"."tunnel_id" IS
  'Immutable tunnel identifier retained after the mutable tunnel connection is deleted.';

-- Legacy device approvals stored the machine bearer in plaintext. New
-- approvals derive it for the five-minute handoff and persist only its hash.
UPDATE "kortix"."tunnel_device_auth_requests"
SET "setup_token" = NULL, "updated_at" = now()
WHERE "setup_token" IS NOT NULL AND "expires_at" < now();

COMMENT ON COLUMN "kortix"."tunnel_device_auth_requests"."setup_token" IS
  'Deprecated legacy handoff field. New approvals never persist plaintext setup tokens.';

-- RPC forward rows are an ephemeral cross-replica queue. Older code retained
-- completed file contents, shell output, and desktop data indefinitely.
DELETE FROM "kortix"."tunnel_rpc_forwards"
WHERE "expires_at" < now();

COMMENT ON TABLE "kortix"."tunnel_rpc_forwards" IS
  'Ephemeral cross-replica tunnel transport. Consumers delete terminal rows and the forwarder deletes rows after expires_at.';
