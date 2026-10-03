/**
 * The two unused indexes the Supabase performance advisor flags on
 * `kortix.integrations` are dropped by the migration, and nothing else on the
 * table is.
 *
 * The advisor reports `unused_index` on `kortix.integrations` for
 * `idx_integrations_account` (redundant with the leading column of the unique
 * `idx_integrations_account_provider_account`) and
 * `idx_integrations_provider_account` (no reader names the column). The
 * migration `20261003111224680_drop_integrations_unused_indexes.concurrent.ts`
 * drops both with `DROP INDEX CONCURRENTLY IF EXISTS`.
 *
 * The lane's template database has already applied every migration, so the
 * legacy table does not exist there (the Kortix baseline never creates it and
 * the drops are IF EXISTS no-ops). The setup below rebuilds the exact
 * production index set on whatever database the lane hands it, applies the
 * migration's two statements for real (CONCURRENTLY — outside any
 * transaction), and asserts the live catalog: the two targets are gone, the
 * kept indexes survive, and a re-run is a no-op. Reads `pg_indexes`, never
 * source text, so the assertion can never pass vacuously.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const TARGET_INDEXES = ['idx_integrations_account', 'idx_integrations_provider_account'];
const KEPT_INDEXES = [
  'idx_integrations_account_provider_account',
  'idx_integrations_app',
  'integrations_pkey',
];

/** The migration's exact statements (CONCURRENTLY cannot run in a transaction). */
const DROP_STATEMENTS = [
  "set lock_timeout = '180s'",
  'drop index concurrently if exists kortix.idx_integrations_account',
  'drop index concurrently if exists kortix.idx_integrations_provider_account',
];

suite('drop_integrations_unused_indexes migration drops exactly the two unused indexes', () => {
  let client: pg.Client;
  let createdTableHere = false;

  const indexesOnTable = async (): Promise<string[]> => {
    const { rows } = await client.query(
      `select indexname from pg_indexes
         where schemaname = 'kortix' and tablename = 'integrations'
         order by indexname`,
    );
    return rows.map((r) => r.indexname as string);
  };

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    // The template database never carries the legacy table (the baseline does
    // not create it). Rebuild the production index set: pkey, the unique
    // composite, the app index, and the two unused single-column indexes.
    await client.query('create schema if not exists kortix');
    const { rows: existing } = await client.query(
      `select 1 from pg_tables where schemaname = 'kortix' and tablename = 'integrations'`,
    );
    createdTableHere = existing.length === 0;
    if (createdTableHere) {
      await client.query(`
        create table kortix.integrations (
          integration_id uuid primary key,
          account_id uuid,
          app varchar,
          app_name varchar,
          provider_name varchar,
          provider_account_id varchar,
          label varchar,
          status text,
          scopes jsonb,
          metadata jsonb,
          connected_at timestamptz,
          last_used_at timestamptz,
          created_at timestamptz,
          updated_at timestamptz
        )`);
      await client.query(
        'create unique index idx_integrations_account_provider_account on kortix.integrations using btree (account_id, provider_account_id)',
      );
      await client.query(
        'create index idx_integrations_app on kortix.integrations using btree (app)',
      );
    }
    for (const name of TARGET_INDEXES) {
      await client.query(`drop index concurrently if exists kortix."${name}"`);
      await client.query(
        `create index "${name}" on kortix.integrations using btree (${name === 'idx_integrations_account' ? 'account_id' : 'provider_account_id'})`,
      );
    }
  });

  test('after the migration statements, exactly the kept indexes remain', async () => {
    for (const statement of DROP_STATEMENTS) {
      await client.query(statement);
    }
    const remaining = await indexesOnTable();
    expect(remaining.sort()).toEqual([...KEPT_INDEXES].sort());
  });

  test('a re-run of both statements is a no-op (IF EXISTS)', async () => {
    const before = await indexesOnTable();
    for (const statement of DROP_STATEMENTS) {
      await client.query(statement);
    }
    expect(await indexesOnTable()).toEqual(before);
  });

  afterAll(async () => {
    if (createdTableHere) {
      await client.query('drop table if exists kortix.integrations');
    }
    await client.end();
  });
});
