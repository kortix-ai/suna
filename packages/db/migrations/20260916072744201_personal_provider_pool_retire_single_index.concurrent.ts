import type { MigrationBuilder } from 'node-pg-migrate';

// mixed-version-safe: user_provider_connections is introduced by this unmerged feature; current main has no readers or writers. The slot index preserves the legacy default connection identity.
export const up = (pgm: MigrationBuilder) => {
  pgm.noTransaction();
  pgm.sql("set lock_timeout = '180s'");
  pgm.sql("set statement_timeout = '30min'");
  pgm.sql('DROP INDEX CONCURRENTLY IF EXISTS kortix.user_provider_connections_user_provider');
};
