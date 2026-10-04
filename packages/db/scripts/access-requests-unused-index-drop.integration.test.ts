/**
 * `kortix.access_requests` carries no secondary indexes.
 *
 * The Supabase performance advisor flags `unused_index` on this table: both
 * secondary indexes the baseline built (`idx_access_requests_email`,
 * `idx_access_requests_status`) have `pg_stat_user_indexes.idx_scan = 0` in
 * prod and no code path reads the table at all (the one reference is the
 * waitlist endpoint's INSERT, apps/api/src/http/access-control/index.ts:123). Dropped by
 * the `.concurrent.ts` migrations; the table itself and its primary key
 * stay. Reads the live catalog, never source text; mirrors
 * `account-secret-resources-fk-index.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** The secondary indexes the committed migrations built and this drop removes. */
const DROPPED_INDEXES = ['idx_access_requests_email', 'idx_access_requests_status'];

suite('kortix.access_requests carries no unused secondary index', () => {
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

  test('the table still exists with its primary key', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{ index_name: string }>(`
        select i.relname as index_name
          from pg_class t
          join pg_index x on x.indrelid = t.oid
          join pg_class i on i.oid = x.indexrelid
          join pg_namespace n on n.oid = t.relnamespace
         where n.nspname = 'kortix'
           and t.relname = 'access_requests'
           and x.indisprimary
      `);
      expect(rows.map((r) => r.index_name)).toEqual(['access_requests_pkey']);
    });
  });

  test('the dropped secondary indexes are gone from the catalog', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{ relname: string }>(
        `
        select c.relname
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_index x on x.indexrelid = c.oid
         where n.nspname = 'kortix'
           and c.relname = any($1)
      `,
        [DROPPED_INDEXES],
      );
      expect(rows.map((r) => r.relname).sort()).toEqual([]);
    });
  });
});
