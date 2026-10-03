// Migration: change_requests_origin_session_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_change_requests_origin_session (kortix.ts) over
// kortix.change_requests.origin_session_id, the FK column behind
// change_requests_origin_session_id_fkey -> project_sessions.session_id
// (ON DELETE SET NULL). The Supabase performance advisor flagged the FK as
// unindexed (unindexed_foreign_keys, KRTX-1096): every ON DELETE SET NULL on
// project_sessions scans change_requests with no covering index. The table's
// other two FK columns already carry idx_change_requests_account and
// idx_change_requests_project; this closes the last one.
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY waits
// for every transaction that began before it, and lock_timeout governs that wait.
// IF NOT EXISTS keeps a re-run safe; an INVALID leftover from a failed build must
// be dropped by hand first (see packages/db/MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_change_requests_origin_session
      on kortix.change_requests using btree (origin_session_id)
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
