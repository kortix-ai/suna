// Migration: sandbox_compute_sessions_ledger_id_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_sandbox_compute_sessions_ledger_id (kortix.ts), the covering
// index for sandbox_compute_sessions_ledger_id_fkey
// (ledger_id -> kortix.credit_ledger.id, ON DELETE SET NULL). The Supabase
// advisor reports the FK as unindexed (unindexed_foreign_keys): deleting a
// credit_ledger row has to find the compute sessions to null without it.
// Partial on ledger_id IS NOT NULL: session rows carry it NULL (no writer
// sets it yet), so the index holds only rows a ledger row can point at.
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
    create index concurrently if not exists idx_sandbox_compute_sessions_ledger_id
      on kortix.sandbox_compute_sessions using btree (ledger_id)
      where ledger_id is not null
  `);
};

export const down = false;
