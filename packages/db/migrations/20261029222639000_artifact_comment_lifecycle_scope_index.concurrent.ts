export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`create index concurrently if not exists idx_session_lifecycle_commands_artifact on kortix.session_lifecycle_commands (artifact_id) where artifact_id is not null`);
};

export const down = false;
