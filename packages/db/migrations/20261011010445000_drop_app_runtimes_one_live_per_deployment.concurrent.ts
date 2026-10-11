// Migration: drop_app_runtimes_one_live_per_deployment  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Replaced by app_runtimes_one_live_per_machine (previous migration).
//
// mixed-version-safe: no code catches a violation of this index; the old API
// writes one runtime per deployment under its deployment lease, and the new
// per-machine index (a superset key) already holds for every old row.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.app_runtimes_one_live_per_deployment`);
};

export const down = false;
