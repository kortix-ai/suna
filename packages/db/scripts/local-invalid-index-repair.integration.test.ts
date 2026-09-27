import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import { dockerAvailable } from './docker-available';
import { dropLocalInvalidIndexes } from './local-invalid-index-repair';

// `pg_stat_progress_create_index` lists index builds in EVERY database of the
// cluster. The local cluster also serves other databases: the db-suites lane
// clones one per test file and builds indexes in them while the product-flow
// lane migrates `postgres`. A build in another database must not block the
// repair of this one. A build in this database still must.

const container = `kortix-invalid-index-repair-${crypto.randomUUID().slice(0, 8)}`;
let adminUrl = '';

function urlFor(database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient<T>(database: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Hold one CREATE INDEX CONCURRENTLY in progress in `database`: an open
 * repeatable-read transaction keeps a snapshot, so the build waits in its
 * "waiting for old snapshots" phase until `release()`.
 */
async function holdIndexBuild(database: string) {
  const holder = new pg.Client({ connectionString: urlFor(database) });
  const builder = new pg.Client({ connectionString: urlFor(database) });
  await holder.connect();
  await builder.connect();
  await holder.query('begin isolation level repeatable read');
  await holder.query('select 1');
  const build = builder
    .query('create index concurrently held_build_idx on kortix.items (id)')
    .catch(() => undefined);
  await withClient(database, async (client) => {
    for (let i = 0; i < 100; i++) {
      const { rows } = await client.query<{ count: number }>(
        'select count(*)::int as count from pg_stat_progress_create_index where datname = current_database()',
      );
      if (rows[0].count > 0) return;
      await Bun.sleep(50);
    }
    throw new Error('the held index build never started');
  });
  return async () => {
    await holder.query('rollback');
    await build;
    await holder.end();
    await builder.end();
  };
}

describe.skipIf(!dockerAvailable)('local invalid-index repair — real PostgreSQL', () => {
  beforeAll(async () => {
    const started = Bun.spawnSync([
      'docker', 'run', '--rm', '-d', '--name', container, '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=target', 'postgres:16-alpine',
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());
    const port = Bun.spawnSync(['docker', 'port', container, '5432/tcp']).stdout.toString().trim().split(':').pop();
    adminUrl = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
    for (let i = 0; i < 100; i++) {
      try {
        await withClient('target', async (client) => client.query('select 1'));
        break;
      } catch {
        await Bun.sleep(200);
      }
    }
    await withClient('postgres', (client) => client.query('create database other'));
    for (const database of ['target', 'other']) {
      await withClient(database, (client) =>
        client.query('create schema kortix; create table kortix.items (id int)'),
      );
    }
  }, 120_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container]);
  });

  test('an index build in another database does not block the repair', async () => {
    await withClient('target', (client) =>
      client.query(`
        create index kortix_items_invalid on kortix.items (id);
        update pg_index set indisvalid = false where indexrelid = 'kortix.kortix_items_invalid'::regclass;
      `),
    );
    const release = await holdIndexBuild('other');
    try {
      await expect(dropLocalInvalidIndexes(urlFor('target'))).resolves.toEqual(['kortix.kortix_items_invalid']);
    } finally {
      await release();
    }
  }, 60_000);

  test('an index build in the same database still blocks the repair', async () => {
    const release = await holdIndexBuild('target');
    try {
      await expect(dropLocalInvalidIndexes(urlFor('target'))).rejects.toThrow('an index build is active');
    } finally {
      await release();
    }
  }, 60_000);
});
