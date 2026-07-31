export const shorthands = undefined;

export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create index concurrently if not exists idx_audit_events_account_session_time
      on kortix.audit_events (account_id, session_id, occurred_at)
  `);
};

export const down = false;
