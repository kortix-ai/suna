// Migration: app_deployments_source_session_idx  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds the index kortix.ts declares as app_deployments_source_session_idx for
// the foreign key app_deployments.source_session_id ->
// project_sessions.session_id (ON DELETE SET NULL). Every deleted session row
// rewrites the referencing rows: without this index that rewrite seq-scans
// app_deployments (Supabase advisor lint `unindexed_foreign_keys`, KRTX-1093).
//
// One CONCURRENTLY build per file and per table (learnings:
// 2026-08-10 one-create-index-concurrently-per-table-at-a-time); the sibling
// index for artifact_id ran in the previous migration.
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY
// waits for every transaction that began before it, and lock_timeout governs
// that wait (learnings: 2026-08-19). The one lock it holds
// (ShareUpdateExclusive) blocks no user. IF NOT EXISTS keeps a re-run safe; an
// INVALID leftover from a failed build must be dropped by hand first (see
// packages/db/MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists app_deployments_source_session_idx
      on kortix.app_deployments using btree (source_session_id)
  `);
};

export const down = false;
