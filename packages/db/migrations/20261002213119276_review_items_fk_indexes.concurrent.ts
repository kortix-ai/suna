// Migration: review_items_fk_indexes  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds the two FK-covering indexes kortix.ts declares on review_items:
//
//   idx_review_items_account        (account_id)
//   idx_review_items_origin_session (origin_session_id)
//
// Supabase's performance advisor flags both foreign keys as unindexed
// (`unindexed_foreign_keys`, KRTX-1112). Without a covering index, the
// parent-side referential actions scan the whole table: deleting an account
// runs `DELETE ... WHERE account_id = $1` (ON DELETE CASCADE), and deleting a
// project session runs `UPDATE ... SET origin_session_id = NULL WHERE
// origin_session_id = $1` (ON DELETE SET NULL). The existing review_items
// indexes all lead with project_id or created_at, so neither action had one.
//
// Two statements, one file: each is IF NOT EXISTS and purely additive, so a
// re-run after a partial failure is safe and no state needs all-or-nothing.
// They run sequentially (one pgm.sql() per statement), which also satisfies
// the one-CIC-per-table-at-a-time rule -- the second build starts only after
// the first has landed.
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
    create index concurrently if not exists idx_review_items_account
      on kortix.review_items using btree (account_id)
  `);
  pgm.sql(`
    create index concurrently if not exists idx_review_items_origin_session
      on kortix.review_items using btree (origin_session_id)
  `);
};

export const down = false;
