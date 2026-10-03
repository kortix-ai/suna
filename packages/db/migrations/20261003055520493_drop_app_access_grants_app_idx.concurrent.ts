// Migration: drop_app_access_grants_app_idx  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.app_access_grants_app_idx` (btree (app_id)): reported by the
// Supabase performance advisor (lint unused_index, INFO) and unused in prod —
// pg_stat_user_indexes shows idx_scan = 0, idx_tup_read = 0, idx_tup_fetch = 0
// over the index's whole lifetime (read-only Management API SQL, 2026-10-03).
// Every extra index costs an index write on each grant INSERT/UPDATE.
//
// Nothing loses a query plan. app_access_grants_unique (btree (app_id,
// principal_type, principal_id)) carries app_id as its leading column, so it
// serves every read the dropped index could: the identity-transfer
// DELETE ... USING kortix.apps (apps/api/src/iam/account-identity.ts) and the
// apps ON DELETE CASCADE walk over app_access_grants_app_id_apps_app_id_fkey.
// Postgres never references an index by name, so a still-running older API
// image plans the same queries through the unique index. The
// unindexed_foreign_keys advisor lint stays quiet too: the FK's column still
// leads an index on the table.
//
// The table is not legacy: every migration chain (fresh install, CI shadow
// database, faked-baseline environments) builds it with
// 20260807211250000_add_app_access_control, which sorts before this file, so
// the index exists everywhere the drop runs. IF EXISTS keeps a re-run after a
// partial failure safe.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.

export const shorthands = undefined;

// mixed-version-safe: read-path only. No application code names the index (a
// git grep of app_access_grants_app_idx over the repo finds only this
// migration and the removed schema declaration). No constraint, ON CONFLICT
// clause, view or policy depends on it: it is a plain non-unique index, and
// the table's only conflict target, app_access_grants_unique, is kept. Old
// code keeps every plan it used (see the header).
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.app_access_grants_app_idx`);
};

// Forward-only: the unique index's leading app_id column covers every read
// the dropped index served.
export const down = false;
