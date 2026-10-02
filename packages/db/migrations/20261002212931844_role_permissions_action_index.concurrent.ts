// Migration: role_permissions_action_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_role_permissions_action (kortix.ts): the covering index for the
// role_permissions_action_permissions_fk foreign key (action ->
// kortix.permissions.action). The table's only other index is the PK
// (role_id, action), which leads with role_id, so every referenced-side UPDATE
// or DELETE on permissions.action takes a sequential scan of role_permissions
// to enforce the FK (Supabase advisor: unindexed_foreign_keys).
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY waits
// for every transaction that began before it, and lock_timeout governs that wait.
// IF NOT EXISTS keeps a re-run safe; an INVALID leftover from a failed build must
// be dropped by hand first (see packages/db/MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string.
  // Postgres's simple query protocol treats a single query string containing
  // multiple ;-separated statements as an IMPLICIT transaction block -- which
  // silently defeats pgm.noTransaction() (CONCURRENTLY still fails with
  // "cannot run inside a transaction block") even though noTransaction() IS
  // working correctly at the node-pg-migrate level. One statement per call.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_role_permissions_action
      on kortix.role_permissions using btree (action)
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
