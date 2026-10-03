// Migration: drop_api_keys_sandbox_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_kortix_api_keys_sandbox` (btree (sandbox_id)) on
// `kortix.api_keys`, reported by the Supabase performance advisor
// (lint unused_index, KRTX-1180). It has never served a scan:
// pg_stat_user_indexes shows idx_scan = 0 / idx_tup_read = 0 and
// pg_stat_database.stats_reset is NULL, so the counters cover the whole
// database lifetime (~37k rows in the table). Every extra index costs an
// index write on each api_keys INSERT/UPDATE, for nothing.
//
// No code reads api_keys by sandbox_id through this index: the only query
// that filters on it, listApiKeys in apps/api/src/repositories/api-keys.ts,
// has no caller, and the planner never chose this index for it anyway
// (idx_scan = 0). The hot auth path reads secret_key_hash
// (idx_kortix_api_keys_secret_hash, 35M+ scans); the unique public_key index
// stays: it enforces uniqueness on every INSERT, which idx_scan never counts.
//
// `DROP INDEX CONCURRENTLY` takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it, and that wait
// blocks nobody.
//
// mixed-version-safe: the index is a plain non-unique btree that backs no
// constraint, no ON CONFLICT clause, no view and no policy (pg_depend on the
// prod database lists only its own table). Postgres never references an
// index by name in a plan, so a still-running older image plans the same
// queries through the same columns: reads fall back to the seq scan it
// already chose, writes lose one dead index maintenance.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql('drop index concurrently if exists kortix.idx_kortix_api_keys_sandbox');
};

// Forward-only: a future sandbox_id reader re-adds a concurrent index when a
// query needs it.
export const down = false;
