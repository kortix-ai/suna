export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create index concurrently if not exists idx_audit_events_account_client_source_time
      on kortix.audit_events (account_id, client_reported_source, occurred_at)
      where client_reported_source is not null
  `);
};

export const down = false;
