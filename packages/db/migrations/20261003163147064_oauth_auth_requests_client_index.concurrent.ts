import type { MigrationBuilder } from 'node-pg-migrate';

// Cover oauth_auth_requests_client_fk without blocking authorization writes.
export const up = (pgm: MigrationBuilder) => {
  pgm.noTransaction();
  pgm.sql("set lock_timeout = '180s'");
  pgm.sql("set statement_timeout = '30min'");
  pgm.sql(
    'create index concurrently if not exists "idx_oauth_auth_requests_client" on "kortix"."oauth_authorization_requests" using btree ("client_id")',
  );
};

export const down = false;
