// Migration: drop_unused_provider_transitions_status_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_provider_transitions_status` on `kortix.provider_transitions`:
// the Supabase performance advisor reports it as unused (lint `unused_index`),
// and pg_stat_user_indexes agrees — idx_scan = 0 since the table's creation
// (20260722235410232_provider_transitions; stats_reset is null, never reset).
// Every extra index costs an index write on each provider_transitions
// INSERT/UPDATE, for nothing.
//
// The read paths never needed it: every status filter in the API is
// `inArray(providerTransitions.status, LIVE)` (apps/api/src/projects/
// provider-transition/provider-transition-store.ts), served by the leading
// status column of the kept idx_provider_transitions_resume
// (status, next_retry_at, heartbeat_at).
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader and
// no writer, and it only unlinks files (no heap rewrite). It cannot run in a
// transaction, hence this .concurrent.ts file (MIGRATIONS.md "Roll-forward
// safety"). lock_timeout is 180s: the statement waits for transactions that
// began before it (learnings 2026-08-19), and that wait blocks nobody.

export const shorthands = undefined;

// mixed-version-safe: read-path only. No code names this index (a repo-wide
// grep over code, tests and docs finds only its schema declaration and its
// creating migration) and no constraint, ON CONFLICT clause, view or policy
// depends on it (a plain non-unique btree). A still-running older image plans
// the same status reads through the kept idx_provider_transitions_resume,
// whose leading column is status.

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_provider_transitions_status`);
};

// Forward-only: nothing re-creates a zero-scan index; a future status-only
// read that outgrows the resume index rebuilds it with CREATE INDEX CONCURRENTLY.
export const down = false;
