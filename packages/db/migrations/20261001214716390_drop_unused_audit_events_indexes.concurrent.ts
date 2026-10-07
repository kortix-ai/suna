// Migration: drop_unused_audit_events_indexes  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops the three kortix.audit_events indexes that no read path can use. Each
// one costs an index write on every audit row (~50 rows/s on prod) and 22 GB of
// the table's 98 GB of indexes. Prod is 145M rows against a 4 GB shared_buffers,
// and every sampled audit INSERT waits on IO:DataFileRead, so each index write is
// a potential cold-page read. See the PR description for the evidence table.
//
//   idx_audit_events_account_session_sequence  (account_id, session_id, session_sequence)   13 GB
//   idx_audit_events_account_project_sequence  (account_id, project_id, session_sequence)  3.5 GB
//   idx_audit_events_resource                  (resource_type, resource_id)                 5.5 GB
//
// The kept indexes cover every read: account/project/session filters use the
// *_time indexes, and the per-session read uses idx_audit_events_session_sequence.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader and
// no writer, and it only unlinks files (no heap rewrite). It cannot run in a
// transaction, hence this .concurrent.ts file (MIGRATIONS.md "Roll-forward
// safety"). lock_timeout is 180s: the statement waits for transactions that
// began before it (learnings 2026-08-19), and that wait blocks nobody.
//
// Three statements, one file: each is IF EXISTS and independent, so a re-run
// after a partial failure is safe and no state needs all-or-nothing. They stay
// separate pgm.sql() calls: a multi-statement string is an implicit transaction
// and CONCURRENTLY would fail inside it.

export const shorthands = undefined;

// mixed-version-safe: read-path only. No application code names these indexes.
// No ON CONFLICT clause targets them (the only conflict targets are
// audit_events_pkey and idx_audit_events_source_phase, both kept). The session
// audit read (project-audit.ts, WHERE session_id = ? ORDER BY session_sequence,
// event_id) and the account/project filters (accounts/audit-filters.ts) keep
// their current indexes, so a still-running older API image plans the same
// queries after the drop.
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_audit_events_account_session_sequence`);
  pgm.sql(`drop index concurrently if exists kortix.idx_audit_events_account_project_sequence`);
  pgm.sql(`drop index concurrently if exists kortix.idx_audit_events_resource`);
};

// Forward-only. Re-creating 22 GB of unread indexes would re-impose their write cost.
export const down = false;
