/**
 * `connection_credentials_connector_connection_fk` keeps a covering index.
 *
 * The composite foreign key (connector_id, connection_id) ->
 * kortix.connector_connections, ON DELETE CASCADE, had no index whose leading
 * columns cover it: the two single-column indexes and both partial unique
 * indexes on the table cannot serve the RI lookup, so every
 * connector_connections delete scanned kortix.connection_credentials. The
 * migration 20261002212941248 builds the covering index CONCURRENTLY; this
 * test fails on a database migrated without it.
 */
import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('connection_credentials FK index — migrated PostgreSQL', () => {
  test('connection_credentials_connector_connection_fk has a covering index', async () => {
    expect(databaseUrl).toBeDefined();
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ covered: boolean }>(
        `with fk as (
           select conkey from pg_constraint
           where conrelid = 'kortix.connection_credentials'::regclass
             and conname = 'connection_credentials_connector_connection_fk'
             and contype = 'f'
         ),
         idx as (
           select i.indkey::int2[] as keys from pg_index i
           where i.indrelid = 'kortix.connection_credentials'::regclass
             and i.indisvalid and i.indpred is null
         )
         select exists (
           select 1 from idx
           where keys[0:array_length(fk.conkey, 1) - 1] = fk.conkey
         ) as covered
         from fk`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.covered).toBe(true);
    } finally {
      await client.end();
    }
  });
});
