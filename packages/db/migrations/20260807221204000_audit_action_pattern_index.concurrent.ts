export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create index concurrently if not exists idx_audit_events_action_pattern
      on kortix.audit_events (action text_pattern_ops)
  `);
};

export const down = false;
