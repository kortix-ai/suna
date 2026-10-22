// Migration: session_lifecycle_commands_forwarded_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_session_lifecycle_commands_forwarded (kortix.ts) for the
// forwarded-prompt sweep (reconcileForwardedPrompts, every maintenance cycle):
// rows whose result still says `forwarded`, oldest updated_at first, limit 25.
// The only index that matched it was (status, available_at), and
// status = 'succeeded' is true for every closed command, so the sweep read the
// whole table. Partial on result->>'status' = 'forwarded': a row leaves the
// index when its prompt is confirmed, so the index holds in-flight prompts only.
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
    create index concurrently if not exists idx_session_lifecycle_commands_forwarded
      on kortix.session_lifecycle_commands using btree (updated_at)
      where (result->>'status') = 'forwarded'
  `);
};

export const down = false;
