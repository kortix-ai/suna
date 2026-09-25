import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import { readDatabase, withReadOnly } from './catalog';

/**
 * `readDatabase` (the one catalog query and the one ledger query) against
 * real PostgreSQL.
 * The db-suites lane supplies TEST_DATABASE_URL: a fresh clone of the
 * migrated template. The fixture lives in its own schema.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const SCHEMA = 'catalog_probe';
const READER = `catalog_probe_reader_${process.pid}`;
const NO_LEDGER = `catalog_probe_no_ledger_${process.pid}`;

async function asOwner(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function ownerRows<T>(sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query(sql)).rows as T[];
  } finally {
    await client.end();
  }
}

/** `databaseUrl` logged in as `role` (password = role name). */
function urlAs(role: string): string {
  const url = new URL(databaseUrl!);
  url.username = role;
  url.password = role;
  return url.toString();
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
      GRANT USAGE ON SCHEMA kortix_migrations TO ${READER};
      GRANT SELECT ON kortix_migrations.pgmigrations TO ${READER};
      DROP ROLE IF EXISTS ${NO_LEDGER};
      CREATE ROLE ${NO_LEDGER} LOGIN PASSWORD '${NO_LEDGER}';
      GRANT USAGE ON SCHEMA kortix_migrations TO ${NO_LEDGER};
    `);
    // A failed CONCURRENTLY build leaves an INVALID index behind.
    await asOwner(`CREATE UNIQUE INDEX CONCURRENTLY child_id_unique ON ${SCHEMA}.child (id)`).catch(() => {});
  });

  afterAll(async () => {
    await asOwner(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      REVOKE ALL ON kortix_migrations.pgmigrations FROM ${READER}, ${NO_LEDGER};
      REVOKE ALL ON SCHEMA kortix_migrations FROM ${READER}, ${NO_LEDGER};
      DROP ROLE IF EXISTS ${READER};
      DROP ROLE IF EXISTS ${NO_LEDGER};
    `);
  });

  test('reads relations, columns, enum values, indexes and constraints', async () => {
    const { catalog } = await readDatabase(databaseUrl!, SCHEMA);

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
    const { catalog } = await readDatabase(databaseUrl!, 'no_such_schema');
    expect(catalog.relations.size + catalog.columns.size + catalog.indexes.size + catalog.constraints.size).toBe(0);
  });

  test('a role without privileges on a table still sees it', async () => {
    const { catalog } = await readDatabase(urlAs(READER), SCHEMA);
    expect(catalog.relations.get('child')).toBe('table');
    expect(catalog.columns.has('child.state')).toBe(true);
  });

  test('a ledger the role cannot read fails the read; it is not read as empty', async () => {
    await expect(readDatabase(urlAs(NO_LEDGER), SCHEMA)).rejects.toThrow(/permission denied/);
  });

  test('the ledger reads in run order: run_on, then id', async () => {
    // Rows whose run_on order differs from their id order and from their name
    // order. ledger_c and ledger_b share a run_on; id breaks the tie. Rows are
    // inserted in none of the three orders.
    await asOwner(`
      CREATE TABLE kortix_migrations.pgmigrations_saved AS TABLE kortix_migrations.pgmigrations;
      DELETE FROM kortix_migrations.pgmigrations;
      INSERT INTO kortix_migrations.pgmigrations (id, name, run_on) VALUES
        (5, 'ledger_b', '2026-01-02 00:00:00'),
        (2, 'ledger_a', '2026-01-03 00:00:00'),
        (1, 'ledger_c', '2026-01-02 00:00:00'),
        (3, 'ledger_d', '2026-01-01 00:00:00');
    `);
    try {
      expect((await readDatabase(databaseUrl!, SCHEMA)).ledger).toEqual(['ledger_d', 'ledger_c', 'ledger_b', 'ledger_a']);
    } finally {
      await asOwner(`
        DELETE FROM kortix_migrations.pgmigrations;
        INSERT INTO kortix_migrations.pgmigrations SELECT * FROM kortix_migrations.pgmigrations_saved;
        DROP TABLE kortix_migrations.pgmigrations_saved;
      `);
    }
  });

  test('a missing ledger reads as empty and is not created', async () => {
    await asOwner('ALTER TABLE kortix_migrations.pgmigrations RENAME TO pgmigrations_hidden');
    try {
      expect((await readDatabase(databaseUrl!, SCHEMA)).ledger).toEqual([]);
    } finally {
      await asOwner('ALTER TABLE kortix_migrations.pgmigrations_hidden RENAME TO pgmigrations');
    }
  });

  test('every read runs in a read-only transaction', async () => {
    await withReadOnly(databaseUrl!, async (client) => {
      expect((await client.query('SHOW transaction_read_only')).rows[0]).toEqual({ transaction_read_only: 'on' });
      await expect(client.query(`CREATE TABLE ${SCHEMA}.must_not_exist (id integer)`)).rejects.toThrow(
        /read-only transaction/,
      );
    });
    const { catalog } = await readDatabase(databaseUrl!, SCHEMA);
    expect(catalog.relations.has('must_not_exist')).toBe(false);
  });

  test('readDatabase closes its session, also when a read fails', async () => {
    const tag = `catalog_probe_${process.pid}`;
    const url = new URL(databaseUrl!);
    url.searchParams.set('application_name', tag);
    await readDatabase(url.toString(), SCHEMA);
    await expect(
      withReadOnly(url.toString(), async (client) => {
        await client.query('SELECT 1 FROM no_such_table');
      }),
    ).rejects.toThrow(/no_such_table/);
    // A backend leaves pg_stat_activity shortly after its client disconnects.
    const openSessions = async () =>
      (await ownerRows<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = '${tag}'`,
      ))[0]!.n;
    let open = await openSessions();
    for (let attempt = 0; open > 0 && attempt < 20; attempt += 1) {
      await Bun.sleep(100);
      open = await openSessions();
    }
    expect(open).toBe(0);
  });
});
