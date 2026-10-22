/**
 * Every foreign key on `basejump.account_user` has a covering index.
 *
 * The Supabase performance advisor flags `unindexed_foreign_keys` on this
 * table (foreign key `account_user_account_id_fkey`): Postgres does not
 * auto-index a foreign key, so every lookup by `account_id` — the RLS policy
 * probes on `kortix.credit_*` and the membership checks the legacy basejump
 * policies run — scans the whole table. Deployed environments carry the
 * legacy basejump table with both foreign keys; a fresh install carries the
 * stub from `test-prereqs.sql` with none. The setup below rebuilds the exact
 * production foreign-key set on whatever database the lane hands it, so the
 * assertion can never pass vacuously.
 *
 * Reads the live catalog (`pg_constraint` / `pg_index`), never source text.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** The foreign keys the legacy basejump extension declares on the table. */
const EXPECTED_FKS: Record<string, { columns: string[]; target: string }> = {
  account_user_user_id_fkey: { columns: ['user_id'], target: 'auth.users (id)' },
  account_user_account_id_fkey: { columns: ['account_id'], target: 'basejump.accounts (id)' },
};

suite('basejump.account_user foreign keys are covered by indexes', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    // The FK targets on a fresh install: auth.users comes from test-prereqs,
    // basejump.accounts does not exist there yet. NOT VALID so a populated
    // (deployed-like) database never scans.
    await client.query('create table if not exists basejump.accounts (id uuid primary key)');
    for (const [name, fk] of Object.entries(EXPECTED_FKS)) {
      if (!/^[a-z_]+$/.test(name)) throw new Error(`unexpected FK name: ${name}`);
      await client.query(`
        do $$
        begin
          if not exists (
            select 1 from pg_constraint
            where conrelid = 'basejump.account_user'::regclass and conname = '${name}'
          ) then
            execute 'alter table basejump.account_user add constraint ${name}
              foreign key (${fk.columns.join(', ')}) references ${fk.target} not valid';
          end if;
        end $$;
      `);
    }
  });

  afterAll(async () => {
    if (!client) return;
    for (const name of Object.keys(EXPECTED_FKS)) {
      await client
        .query(`alter table basejump.account_user drop constraint if exists ${name}`)
        .catch(() => undefined);
    }
    await client.end();
  });

  test('the table carries the production foreign-key set', async () => {
    const { rows } = await client.query<{ name: string }>(`
      select c.conname as name
        from pg_constraint c
       where c.conrelid = 'basejump.account_user'::regclass
         and c.contype = 'f'
       order by c.conname
    `);
    expect(rows.map((r) => r.name).sort()).toEqual(Object.keys(EXPECTED_FKS).sort());
  });

  test('every foreign key on the table has a covering index', async () => {
    const { rows: fks } = await client.query<{
      name: string;
      columns: string[];
    }>(`
      select c.conname as name,
             array_agg(a.attname::text order by u.ord) as columns
        from pg_constraint c
        cross join unnest(c.conkey) with ordinality as u(attnum, ord)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = u.attnum
       where c.conrelid = 'basejump.account_user'::regclass
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
       where i.indrelid = 'basejump.account_user'::regclass
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
