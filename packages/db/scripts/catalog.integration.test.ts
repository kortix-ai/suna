import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import { connectReadOnly, readCatalog, readLedger } from './catalog';

/**
 * The one catalog query and the one ledger query, against real PostgreSQL.
 * The db-suites lane supplies TEST_DATABASE_URL: a fresh clone of the
 * migrated template. The fixture lives in its own schema.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const SCHEMA = 'catalog_probe';
const READER = `catalog_probe_reader_${process.pid}`;

async function asOwner(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function read<T>(url: string, reader: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await connectReadOnly(url);
  return reader(client).finally(() => client.end());
}

suite('catalog.ts — real PostgreSQL', () => {
  beforeAll(async () => {
    await asOwner(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      CREATE TYPE ${SCHEMA}.state AS ENUM ('open', 'closed');
      CREATE TABLE ${SCHEMA}.parent (id integer PRIMARY KEY, code text UNIQUE);
      CREATE TABLE ${SCHEMA}.child (
        id integer,
        parent_id integer REFERENCES ${SCHEMA}.parent (id),
        state ${SCHEMA}.state,
        dropped integer
      );
      ALTER TABLE ${SCHEMA}.child DROP COLUMN dropped;
      CREATE INDEX child_state_idx ON ${SCHEMA}.child (state);
      CREATE VIEW ${SCHEMA}.open_children AS SELECT id FROM ${SCHEMA}.child WHERE state = 'open';
      INSERT INTO ${SCHEMA}.child (id) VALUES (1), (1);
      ALTER TABLE ${SCHEMA}.child ADD CONSTRAINT child_id_positive CHECK (id > 0) NOT VALID;
      DROP ROLE IF EXISTS ${READER};
      CREATE ROLE ${READER} LOGIN PASSWORD '${READER}';
      GRANT USAGE ON SCHEMA ${SCHEMA} TO ${READER};
    `);
    // A failed CONCURRENTLY build leaves an INVALID index behind.
    await asOwner(`CREATE UNIQUE INDEX CONCURRENTLY child_id_unique ON ${SCHEMA}.child (id)`).catch(() => {});
  });

  afterAll(async () => {
    await asOwner(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; DROP ROLE IF EXISTS ${READER};`);
  });

  test('reads relations, columns, enum values, indexes and constraints', async () => {
    const catalog = await read(databaseUrl!, (client) => readCatalog(client, SCHEMA));

    expect(catalog.relations).toEqual(
      new Map([['parent', 'table'], ['child', 'table'], ['open_children', 'view']]),
    );
    expect([...catalog.columns].sort()).toEqual([
      'child.id', 'child.parent_id', 'child.state', 'open_children.id', 'parent.code', 'parent.id',
    ]);
    expect(catalog.enumValues).toEqual(new Set(['state.open', 'state.closed']));

    expect(catalog.indexes.get('parent_pkey')).toMatchObject({ table: 'parent', unique: true, valid: true, backsConstraint: true });
    expect(catalog.indexes.get('parent_code_key')).toMatchObject({ unique: true, backsConstraint: true });
    expect(catalog.indexes.get('child_state_idx')).toEqual({
      table: 'child',
      definition: `CREATE INDEX child_state_idx ON ${SCHEMA}.child USING btree (state)`,
      unique: false,
      valid: true,
      backsConstraint: false,
    });
    expect(catalog.indexes.get('child_id_unique')).toMatchObject({ unique: true, valid: false, backsConstraint: false });

    expect(catalog.constraints.get('child_parent_id_fkey')).toMatchObject({ table: 'child', type: 'f', validated: true });
    expect(catalog.constraints.get('child_id_positive')).toEqual({
      table: 'child',
      type: 'c',
      definition: 'CHECK ((id > 0)) NOT VALID',
      validated: false,
    });
    expect(catalog.constraints.get('parent_code_key')).toMatchObject({ type: 'u', definition: 'UNIQUE (code)' });
  });

  test('a schema that does not exist is an empty catalog', async () => {
    const catalog = await read(databaseUrl!, (client) => readCatalog(client, 'no_such_schema'));
    expect(catalog.relations.size + catalog.columns.size + catalog.indexes.size + catalog.constraints.size).toBe(0);
  });

  test('a role without privileges on a table still sees it', async () => {
    const reader = new URL(databaseUrl!);
    reader.username = READER;
    reader.password = READER;
    const catalog = await read(reader.toString(), (client) => readCatalog(client, SCHEMA));
    expect(catalog.relations.get('child')).toBe('table');
    expect(catalog.columns.has('child.state')).toBe(true);
  });

  test('the ledger reads in run order', async () => {
    const ledger = await read(databaseUrl!, readLedger);
    expect(ledger.length).toBeGreaterThan(100);
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ name: string }>(
        'SELECT name FROM kortix_migrations.pgmigrations ORDER BY run_on, id',
      );
      expect(ledger).toEqual(rows.map((row) => row.name));
    } finally {
      await client.end();
    }
  });

  test('a missing ledger reads as empty and is not created', async () => {
    await asOwner('ALTER TABLE kortix_migrations.pgmigrations RENAME TO pgmigrations_hidden');
    try {
      expect(await read(databaseUrl!, readLedger)).toEqual([]);
    } finally {
      await asOwner('ALTER TABLE kortix_migrations.pgmigrations_hidden RENAME TO pgmigrations');
    }
  });

  test('every read runs in a read-only transaction', async () => {
    const client = await connectReadOnly(databaseUrl!);
    try {
      expect((await client.query('SHOW transaction_read_only')).rows[0]).toEqual({ transaction_read_only: 'on' });
      await expect(client.query(`CREATE TABLE ${SCHEMA}.must_not_exist (id integer)`)).rejects.toThrow(
        /read-only transaction/,
      );
    } finally {
      await client.end();
    }
    const after = await read(databaseUrl!, (c) => readCatalog(c, SCHEMA));
    expect(after.relations.has('must_not_exist')).toBe(false);
  });
});
