// Migration: session_presence_leases_session_fk_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds the index kortix.ts declares as idx_session_presence_leases_session_id
// to cover the FK session_presence_session_fk (20260930143239408): the PK leads
// with user_id, so the ON DELETE cascade fired by a project_sessions delete
// scans this table by session_id without an index (Supabase advisor:
// unindexed_foreign_keys). One CONCURRENTLY build per file and per table
// (learnings: one CREATE INDEX CONCURRENTLY per table at a time).
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY
// waits for every transaction that began before it, and lock_timeout governs
// that wait. The one lock it holds (ShareUpdateExclusive) blocks no user.
// IF NOT EXISTS keeps a re-run safe; an INVALID leftover from a failed build
// must be dropped by hand first (see packages/db/MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_session_presence_leases_session_id
      on kortix.session_presence_leases using btree (session_id)
  `);
};

export const down = false;
