/**
 * Every foreign key on `kortix.account_secret_resources` has a covering index.
 *
 * The Supabase performance advisor flags `unindexed_foreign_keys` on this
 * table (foreign key `account_secret_resources_project_id_projects_project_id_fk`):
 * Postgres does not auto-index a foreign key, so a project delete's
 * `ON DELETE cascade` — and every RI check on `project_id` — scans the whole
 * table. Both foreign keys come from the committed migrations on every
 * environment, fresh or deployed. Reads the live catalog
 * (`pg_constraint` / `pg_index`), never source text; mirrors
 * `basejump-account-user-fk-index.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** The foreign keys the committed migrations declare on the table. */
const EXPECTED_FKS: Record<string, { columns: string[] }> = {
  account_secret_resources_account_id_accounts_account_id_fk: { columns: ['account_id'] },
  account_secret_resources_project_id_projects_project_id_fk: { columns: ['project_id'] },
};

suite('kortix.account_secret_resources foreign keys are covered by indexes', () => {
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

  test('the table carries the migration foreign-key set', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{ name: string }>(`
        select c.conname as name
          from pg_constraint c
         where c.conrelid = 'kortix.account_secret_resources'::regclass
           and c.contype = 'f'
         order by c.conname
      `);
      expect(rows.map((r) => r.name).sort()).toEqual(Object.keys(EXPECTED_FKS).sort());
    });
  });

  test('every foreign key on the table has a covering index', async () => {
    await withClient(async (client) => {
      const { rows: fks } = await client.query<{
        name: string;
        columns: string[];
      }>(`
        select c.conname as name,
               array_agg(a.attname::text order by u.ord) as columns
          from pg_constraint c
          cross join unnest(c.conkey) with ordinality as u(attnum, ord)
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = u.attnum
         where c.conrelid = 'kortix.account_secret_resources'::regclass
           and c.contype = 'f'
         group by c.conname
         order by c.conname
      `);

      const { rows: indexes } = await client.query<{
        index_name: string;
        valid: boolean;
        columns: string[];
      }>(`
        select i.indexrelid::regclass::text as index_name,
               i.indisvalid as valid,
               array_agg(a.attname::text order by u.ord) as columns
          from pg_index i
          cross join unnest(i.indkey::smallint[]) with ordinality as u(attnum, ord)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = u.attnum
         where i.indrelid = 'kortix.account_secret_resources'::regclass
           and a.attnum <> 0
         group by i.indexrelid, i.indisvalid
      `);

      // A foreign key is covered when some valid index lists its columns, in
      // order, as a leading prefix — the rule the Supabase advisor checks.
      const coveringIndex = (fkColumns: string[]): string | null =>
        indexes.find(
          (idx) =>
            idx.valid &&
            idx.columns.length >= fkColumns.length &&
            fkColumns.every((col, i) => idx.columns[i] === col),
        )?.index_name ?? null;

      const uncovered = fks
        .map((fk) => ({ name: fk.name, columns: fk.columns, index: coveringIndex(fk.columns) }))
        .filter((fk) => !fk.index);
      expect(uncovered).toEqual([]);
    });
  });
});
