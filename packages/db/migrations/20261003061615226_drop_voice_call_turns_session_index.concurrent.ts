// Migration: drop_voice_call_turns_session_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_voice_call_turns_session` on `kortix.voice_call_turns`:
// it has never served a query (the Supabase performance advisor reports
// `unused_index` on it, read-only 2026-10-03), so it is a pure index-write
// tax on every turn INSERT. The table's one hot read pattern is "everything
// in this call after cursor X" (served by the kept
// `idx_voice_call_turns_call_cursor`; 109k scans over the same stats window).
// The table itself is the dormant compatibility table for the removed
// experimental voice runtime -- a later contract migration removes it whole
// after every old API pod is retired; this drops only the dead index until
// then.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// mixed-version-safe: drops a plain non-unique btree index that no code names
// and no query has ever used (pg_stat_user_indexes.idx_scan = 0 over the
// unbroken stats window since the 2026-09-09 postmaster start; the only
// in-repo reader of the table queries by (call_id, cursor), which the kept
// index serves). pg_depend shows nothing depends on it -- no constraint, view
// or policy -- and Postgres never plans through an index by name, so old code
// still running against the new schema cannot miss it.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_voice_call_turns_session`);
};

// Forward-only: nothing reads this index, and the table's contract migration
// drops the whole table later anyway.
export const down = false;
