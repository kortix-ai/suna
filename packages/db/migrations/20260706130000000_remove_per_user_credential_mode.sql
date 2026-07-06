-- Up Migration
--
-- Remove the `per_user` executor connector credential mode (decided 2026-07-05,
-- docs/specs/2026-07-05-agent-first-config-unification.md §2.5). Prod sizing:
-- 248 per_user connectors across 138 accounts, but only 69 stored per-member
-- credential rows — the migration is tractable and safe.
--
-- CRITICAL — NO SILENT CREDENTIAL PROMOTION: a per-member OAuth is a personal
-- identity. We never let one member's credential become the shared one. So for
-- every connector currently in `per_user` mode:
--   1. Delete its per-member credential rows (user_id IS NOT NULL) — these are
--      personal connections, not project-owned, and must not survive the flip.
--   2. Flip the connector to `credential_mode = 'shared'`.
-- A connector that already had a userId-NULL (shared) row keeps it untouched —
-- only the personal rows are removed. A connector with no shared row at all now
-- has no credential and surfaces "reconnect required" in the dashboard/CLI
-- until someone with connector-write reconnects it.
--
-- Enum disposition: Postgres cannot cleanly DROP a value from an existing enum
-- type (would require rebuilding the type + every column using it). We leave
-- `per_user` as an ORPHANED value in `kortix.executor_credential_mode` — it
-- still exists as a possible enum literal, but nothing in the application
-- writes it anymore (removed from every write path in this same change), and
-- this migration guarantees no existing row carries it. The CHECK constraint
-- below is belt-and-suspenders: it makes `shared` the only value Postgres will
-- accept for this column going forward, independent of app-layer discipline.

DELETE FROM "kortix"."executor_credentials" AS ec
USING "kortix"."executor_connectors" AS conn
WHERE ec.connector_id = conn.connector_id
  AND conn.credential_mode = 'per_user'
  AND ec.user_id IS NOT NULL;

UPDATE "kortix"."executor_connectors"
SET credential_mode = 'shared', updated_at = now()
WHERE credential_mode = 'per_user';

ALTER TABLE "kortix"."executor_connectors"
  ADD CONSTRAINT "executor_connectors_credential_mode_shared_only"
  CHECK (credential_mode = 'shared');

-- Down Migration
--
-- Reversible only in the narrow "undo the constraint" sense — the deleted
-- per-member credential rows and the prior `per_user` flags are NOT
-- recoverable (this is a deliberate, safety-motivated data removal).
ALTER TABLE "kortix"."executor_connectors"
  DROP CONSTRAINT IF EXISTS "executor_connectors_credential_mode_shared_only";
