export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create unique index concurrently if not exists idx_audit_events_source_phase
      on kortix.audit_events
        (source_ledger, source_record_id, phase, coalesce(source_revision, ''))
      where source_ledger is not null and source_record_id is not null
  `);
};

export const down = false;
