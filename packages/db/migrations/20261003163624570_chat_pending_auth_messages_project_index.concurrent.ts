// Migration: chat_pending_auth_messages_project_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Covers the chat_pending_auth_messages_project_id_fkey foreign key
// (project_id -> kortix.projects, ON DELETE CASCADE) with an index. Postgres
// does not auto-index a foreign key, so without an index leading with
// project_id every project deletion seq-scans this table to find cascade
// children — the exact shape the Supabase performance advisor reports as
// unindexed_foreign_keys on this table (KRTX-1097).
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY
// waits for every transaction that began before it, and lock_timeout governs
// that wait. IF NOT EXISTS keeps a re-run safe; an INVALID leftover from a
// failed build must be dropped by hand first (see packages/db/MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_chat_pending_auth_messages_project
      on kortix.chat_pending_auth_messages using btree (project_id)
  `);
};

export const down = false;
