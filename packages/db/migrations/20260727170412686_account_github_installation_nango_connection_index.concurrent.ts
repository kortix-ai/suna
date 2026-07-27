// Migration: account_github_installation_nango_connection_index
//
// The table is populated. Build the partial unique index without blocking
// account installation writes.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create unique index concurrently
      idx_account_github_installations_nango_connection
    on kortix.account_github_installations (nango_connection_id)
    where nango_connection_id is not null
  `);
};

export const down = false;
