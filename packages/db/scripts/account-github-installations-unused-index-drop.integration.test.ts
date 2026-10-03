/**
 * The two single-column indexes the Supabase performance advisor flags as
 * `unused_index` on `kortix.account_github_installations` are gone once the
 * migrations run, and the indexes every read path uses are still valid.
 *
 * The advisor reports `unused_index` for `idx_account_github_installations_account`
 * and `idx_account_github_installations_owner`: prod `pg_stat_user_indexes`
 * shows idx_scan = 0 for both (cumulative counters, never reset, 2026-10-03),
 * while every read filters account_id first and the kept unique
 * (account_id, installation_id) index serves that prefix scan. The migration
 * `20261003104702131_drop_unused_account_github_installation_indexes
 * .concurrent.ts` drops both.
 *
 * Reads the live catalog (`pg_index`), never source text, so the assertion can
 * never pass vacuously; the first test pins the table's existence so a missing
 * table cannot fake a green run.
 */
import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** The index every account-scoped read and the upsert invariant rely on. */
const KEPT_INDEXES: Record<string, { columns: string[]; unique: boolean }> = {
  account_github_installations_pkey: { columns: ['installation_row_id'], unique: true },
  idx_account_github_installations_account_installation: {
    columns: ['account_id', 'installation_id'],
    unique: true,
  },
  uniq_account_github_installations_owner: { columns: ['account_id', 'owner_login'], unique: true },
};

/** The two indexes the advisor flagged and the migration drops. */
const DROPPED_INDEXES = [
  'idx_account_github_installations_account',
  'idx_account_github_installations_owner',
];

suite('account_github_installations unused indexes are dropped', () => {
  let client: pg.Client;

  test('the table under test exists', async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const { rows } = await client.query<{ exists: boolean }>(`
      select exists (
        select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'kortix' and c.relname = 'account_github_installations'
      ) as exists
    `);
    expect(rows[0]?.exists).toBe(true);
  });

  test('the two flagged unused indexes are gone', async () => {
    const { rows } = await client.query<{ index_name: string }>(`
      select i.indexrelid::regclass::text as index_name
        from pg_index i
        join pg_class c on c.oid = i.indrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'kortix'
         and c.relname = 'account_github_installations'
    `);
    const names = rows.map((r) => r.index_name.replace(/^kortix\./, ''));
    expect(names.filter((name) => DROPPED_INDEXES.includes(name))).toEqual([]);
  });

  test('the kept read-path indexes are present, valid and unique as declared', async () => {
    const { rows } = await client.query<{
      index_name: string;
      unique: boolean;
      valid: boolean;
      columns: string[];
    }>(`
      select i.indexrelid::regclass::text as index_name,
             i.indisunique as unique,
             i.indisvalid as valid,
             array_agg(a.attname::text order by u.ord) as columns
        from pg_index i
        join pg_class c on c.oid = i.indrelid
        join pg_namespace n on n.oid = c.relnamespace
        cross join unnest(i.indkey::smallint[]) with ordinality as u(attnum, ord)
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = u.attnum
       where n.nspname = 'kortix'
         and c.relname = 'account_github_installations'
       group by i.indexrelid, i.indisunique, i.indisvalid
    `);
    const byName = new Map(rows.map((r) => [r.index_name.replace(/^kortix\./, ''), r]));
    for (const [name, expected] of Object.entries(KEPT_INDEXES)) {
      const index = byName.get(name);
      expect(index).toBeDefined();
      expect(index?.valid).toBe(true);
      expect(index?.unique).toBe(expected.unique);
      expect(index?.columns).toEqual(expected.columns);
    }
  });
});
