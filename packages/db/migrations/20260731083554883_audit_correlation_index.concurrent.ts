export const shorthands = undefined;

export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create index concurrently if not exists idx_audit_events_correlation
      on kortix.audit_events (correlation_id)
  `);
};

export const down = false;
