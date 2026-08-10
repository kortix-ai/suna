export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create index concurrently if not exists idx_audit_events_account_source_phase_time
      on kortix.audit_events (account_id, authoritative_source, phase, occurred_at)
  `);
};

export const down = false;
