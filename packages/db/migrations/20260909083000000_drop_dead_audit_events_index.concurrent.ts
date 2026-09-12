// Migration: drop_dead_audit_events_index (NON-TRANSACTIONAL — DROP INDEX CONCURRENTLY)
//
// `idx_audit_events_account_source_phase_time` (account_id, authoritative_source,
// phase, occurred_at) costs one index write on EVERY audit row and has never
// served a read.
//
// PROD 2026-09-09, `pg_stat_user_indexes` since the 2026-06-24 stats reset —
// 2.5 months, 98.4M rows inserted in that window:
//
//     idx_audit_events_account_source_phase_time   8622 MB   idx_scan 0   idx_tup_read 0
//
// It is the third-largest of the table's 15 indexes (75 GB of indexes over an
// 84 GB heap). Audit ingest is the largest error class in production —
// 1,115,227 × `503 audit ingestion is contended` in seven days — because each
// 25-row chunk insert maintains all 15 indexes against a working set far larger
// than cache, so the tail runs past the audit pool's 10s statement timeout and
// the relay retries into its own queue. Removing an index nothing reads removes
// that share of the write with no query to regress: a filter on
// (authoritative_source, phase) still has `idx_audit_events_account_time`
// (account_id, occurred_at) for the same account+time prefix.
//
// The sibling `idx_audit_events_account_client_source_time` is also at 0 scans
// but is PARTIAL (`where client_reported_source is not null`), so it is not
// maintained for the ordinary row and is deliberately left in place.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE, blocks no reader and no
// writer, and only unlinks — it never rewrites the 84 GB heap. lock_timeout is
// 180s for the same reason the CIC migrations use it (learnings 2026-08-19,
// "CIC under a 5-second lock_timeout"): it waits on transactions that started
// before it while blocking nobody.
//
// mixed-version-safe: read-path only. No application code names this index.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  await pgm.sql(`set lock_timeout = '180s'`);
  await pgm.sql(`set statement_timeout = '30min'`);
  await pgm.sql(`drop index concurrently if exists "kortix"."idx_audit_events_account_source_phase_time"`);
};

// Forward-only. Re-creating an 8.6 GB index nothing reads would re-impose the
// write cost this migration exists to remove.
export const down = false;
