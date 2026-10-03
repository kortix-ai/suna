// Migration: drop_trigger_session_access_grants_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_trigger_session_access_grants_trigger` on
// kortix.project_trigger_session_access_grants: btree (project_id, slug), reported by
// the Supabase performance advisor (lint unused_index) and confirmed unused on prod
// (pg_stat_user_indexes.idx_scan = 0 since the table was created by
// 20260816090000000_trigger_session_access.sql; every read of the table filters on
// (project_id, slug) or (project_id)).
//
// idx_trigger_session_access_grants_unique on (project_id, slug, principal_type,
// principal_id) has the same leading columns, so every access path this index served
// keeps an equivalent plan: the grant reads in apps/api/src/projects/
// trigger-session-access.ts, the grant-transfer INSERT/DELETE in
// apps/api/src/iam/account-identity.ts, and the FK cascade lookup for
// project_trigger_session_access_grants_trigger_fk. The unique index is also the
// arbiter for that table's only ON CONFLICT clause, so conflict checks are unaffected.
//
// Nothing references the dropped index by name: a git grep over the repo finds only
// its kortix.ts declaration (removed here) and its creating migration. pg_depend on
// the prod database lists no constraint, view or policy depending on it, and it backs
// no constraint (pg_constraint.conindid is empty) — it is a plain secondary index.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader and no
// writer. It cannot run in a transaction, hence this .concurrent.ts file
// (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the statement waits
// for transactions that began before it (learnings 2026-08-19), and that wait blocks
// nobody. IF EXISTS keeps a re-run safe on a database where the index is already gone.
//
// mixed-version-safe: drops only a redundant secondary index. A still-running older
// image plans the same queries through idx_trigger_session_access_grants_unique,
// whose leading (project_id, slug) columns are identical, so no query loses its
// access path while the roll finishes.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_trigger_session_access_grants_trigger`);
};

// Forward-only: the kept unique index (identical leading columns) serves every
// access path this index served.
export const down = false;
