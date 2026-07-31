export const shorthands = undefined;

export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create index concurrently if not exists idx_audit_events_request
      on kortix.audit_events (request_id)
  `);
};

export const down = false;
