// Migration: drop_idx_access_requests_status  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Drops idx_access_requests_status (built by 20260621094136410_baseline.sql:1703):
// the Supabase performance advisor reports `unused_index` on kortix.access_requests,
// and prod's pg_stat_user_indexes shows idx_scan = 0 for it. No code path reads the
// table by status (the API has no query on access_requests at all -- grep finds only
// the Drizzle declaration), so the index is dead weight on every write.
//
// House .concurrent.ts rules (lint-enforced): ONE concurrent operation, IF EXISTS so
// a re-run is safe, lock_timeout 180s (never the 2-5s plain-migration value:
// CONCURRENTLY waits on every older transaction and lock_timeout governs that wait),
// generous statement_timeout. A failed DROP INDEX CONCURRENTLY leaves the index
// valid and in place -- a plain re-run finishes it.
//
// mixed-version-safe: old code tolerates the drop. access_requests is write-only in
// the app: no SELECT filters or joins on status (grep over apps/ and packages/ finds
// zero references outside the waitlist INSERT, kortix.ts and the migration
// history), so no running app version can plan a scan that needs this index. The
// Drizzle declaration leaves in the same commit.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql('drop index concurrently if exists kortix.idx_access_requests_status');
};

export const down = false;
