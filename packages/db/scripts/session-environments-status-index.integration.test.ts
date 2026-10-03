/**
 * `kortix.idx_session_environments_status` is dropped, and the indexes every
 * query still reads survive.
 *
 * The Supabase performance advisor flags the status index as `unused_index`
 * (KRTX-1206): `pg_stat_user_indexes.idx_scan` is 0 for it on prod, while the
 * table's other indexes have scans. Nothing in the codebase filters
 * `session_environments` by `status` alone — every read reaches a row by
 * `session_id` (the primary key) or by `external_id` — so the index only
 * costs an index write per INSERT/UPDATE. The drop migration is
 * `20261003055623164_drop_session_environments_status_index.concurrent.ts`.
 * Reads the live catalog (`pg_indexes`), never source text; mirrors
 * `account-secret-resources-fk-index.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** The index set the committed migrations leave on the table after the drop. */
const EXPECTED_INDEXES = [
  'idx_session_environments_account',
  'idx_session_environments_external_id',
  'idx_session_environments_project',
  'session_environments_pkey',
].sort();

suite('kortix.session_environments index set after the unused-index drop', () => {
  // One fresh client per test: a pg Client cannot reconnect after end().
  const withClient = async (fn: (client: pg.Client) => Promise<void>) => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await fn(client);
    } finally {
      await client.end();
    }
  };

  test('the dropped status index no longer exists', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{ exists: boolean }>(
        `select to_regclass('kortix.idx_session_environments_status') is not null as exists`,
      );
      expect(rows[0].exists).toBe(false);
    });
  });

  test('the table keeps exactly the indexes the queries still read', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{ name: string }>(`
        select indexname as name
          from pg_indexes
         where schemaname = 'kortix'
           and tablename = 'session_environments'
         order by indexname
      `);
      expect(rows.map((r) => r.name)).toEqual(EXPECTED_INDEXES);
    });
  });
});
