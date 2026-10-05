import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder) => {
  pgm.noTransaction();
  pgm.sql("set lock_timeout = '180s'");
  pgm.sql("set statement_timeout = '30min'");
  pgm.sql('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS user_provider_connections_user_provider_slot ON kortix.user_provider_connections (user_id, provider_id, slot)');
};
