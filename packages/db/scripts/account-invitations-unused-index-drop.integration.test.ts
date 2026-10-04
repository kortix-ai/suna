/**
 * `kortix.account_invitations` carries exactly its primary key and the two
 * secondary indexes every query plan still uses.
 *
 * The Supabase performance advisor flags `unused_index` on this table: the two
 * secondary indexes the baseline built (`idx_account_invitations_email`,
 * `idx_account_invitations_account`) have `pg_stat_user_indexes.idx_scan = 0`
 * in prod — every email lookup filters `lower(email)`, which a plain btree on
 * `email` cannot serve, and every `account_id` predicate keeps the leading
 * column of the unique `idx_account_invitations_pending (account_id, email)`.
 * Dropped by the `.concurrent.ts` migration; the table, its primary key and
 * the two live indexes stay. Reads the live catalog, never source text;
 * mirrors `access-requests-unused-index-drop.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** The secondary indexes the committed migrations built and this drop removes. */
const DROPPED_INDEXES = ['idx_account_invitations_email', 'idx_account_invitations_account'];

/** The catalog shape after the drop: the primary key plus the two live reads. */
const SURVIVING_INDEXES = [
  'account_invitations_pkey',
  'idx_account_invitations_expires_at',
  'idx_account_invitations_pending',
];

suite('kortix.account_invitations carries no unused secondary index', () => {
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

  test('the table keeps its primary key and the two live indexes, exactly', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{ index_name: string }>(`
        select i.relname as index_name
          from pg_class t
          join pg_index x on x.indrelid = t.oid
          join pg_class i on i.oid = x.indexrelid
          join pg_namespace n on n.oid = t.relnamespace
         where n.nspname = 'kortix'
           and t.relname = 'account_invitations'
      `);
      expect(rows.map((r) => r.index_name).sort()).toEqual(SURVIVING_INDEXES);
    });
  });
});
