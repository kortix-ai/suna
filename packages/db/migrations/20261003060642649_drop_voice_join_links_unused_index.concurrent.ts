// Migration: drop_voice_join_links_unused_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// `idx_voice_join_links_call` (btree on call_id) was built with its table in
// 20260726150239771_voice_join_links and has never served a read. The Supabase
// performance advisor flags it as `unused_index` (INFO, EXTERNAL facing) and
// prod `pg_stat_user_indexes` agrees over the table's whole life (2026-10-03,
// KRTX-1214):
//
//     idx_voice_join_links_call   8192 bytes   idx_scan 0   indisvalid t
//
// The table itself is dormant: it is the compatibility table for the removed
// experimental voice runtime, no application code reads it beyond the
// `kortix.ts` declaration, and even the primary key shows 0 scans with the
// table never ANALYZEd. An index write on it is unmeasurable, but every unused
// index is one the advisor keeps flagging and one more object every schema diff
// carries, so drop it.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader and
// no writer, and only unlinks — no heap rewrite. On this table it completes
// instantly. lock_timeout is 180s for the same reason the CIC migrations use it
// (learnings 2026-08-19): the statement waits on transactions that began before
// it, and that wait blocks nobody. IF EXISTS keeps a re-run safe.
//
// mixed-version-safe: read-path only. No application code names this index
// (the only references were the kortix.ts declaration this change removes and
// the migration that built it). It is not unique, so no ON CONFLICT clause can
// target it. A still-running old image at worst plans a call_id filter as a seq
// scan of a dormant table.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists "kortix"."idx_voice_join_links_call"`);
};

// Forward-only. Re-creating the index would re-impose the advisor finding this
// migration exists to clear.
export const down = false;
