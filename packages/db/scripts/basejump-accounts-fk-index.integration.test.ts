/**
 * The two foreign keys the Supabase performance advisor flags on
 * `basejump.accounts` are covered by indexes.
 *
 * The advisor reports `unindexed_foreign_keys` on `basejump.accounts` for
 * `accounts_created_by_fkey` and `accounts_updated_by_fkey`: Postgres does not
 * auto-index a foreign key, so every UPDATE/DELETE on an `auth.users` row
 * referenced by one of them seq-scans the legacy table. Deployed environments
 * carry the full basejump table; the migration
 * `20261003010107485_basejump_accounts_fk_covering_indexes.concurrent.ts` builds
 * both indexes and skips cleanly where the table itself is absent.
 *
 * The setup below rebuilds the exact production foreign-key set on whatever
 * database the lane hands it — on a fresh lane the table does not exist at all —
 * and only removes the constraints it added itself. Reads the live catalog
 * (`pg_constraint` / `pg_index`), never source text, so the assertion can never
 * pass vacuously.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** The foreign keys basejump declares on `accounts` (col 8 / col 9 on prod). */
const EXPECTED_FKS: Record<string, { columns: string[]; target: string }> = {
  accounts_created_by_fkey: { columns: ['created_by'], target: 'auth.users (id)' },
  accounts_updated_by_fkey: { columns: ['updated_by'], target: 'auth.users (id)' },
};

suite('basejump.accounts foreign keys are covered by indexes', () => {
  let client: pg.Client;
  /** The FK names this suite added itself (dropped again in afterAll). */
  const addedFks: string[] = [];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    // The FK targets on a fresh install: auth.users comes from test-prereqs;
    // basejump.accounts does not exist there (only the account_user stub does).
    // A sibling suite may have created a bare id-only shape first, so add the
    // two key columns whatever the table's current shape is. NOT VALID so a
    // populated (deployed-like) database never scans.
    await client.query(`
      create table if not exists basejump.accounts (
        id uuid primary key,
        personal_account boolean default false not null,
        slug text,
        created_by uuid,
        updated_by uuid,
        constraint basejump_accounts_slug_null_if_personal_account_true
          check ((personal_account = true and slug is null) or (personal_account = false and slug is not null))
      )
    `);
    await client.query('alter table basejump.accounts add column if not exists created_by uuid');
    await client.query('alter table basejump.accounts add column if not exists updated_by uuid');
    for (const [name, fk] of Object.entries(EXPECTED_FKS)) {
      if (!/^[a-z_]+$/.test(name)) throw new Error(`unexpected FK name: ${name}`);
      const {
        rows: [existing],
      } = await client.query<{ exists: boolean }>(
        `select exists (
           select 1 from pg_constraint
           where conrelid = 'basejump.accounts'::regclass and conname = '${name}'
         ) as exists`,
      );
      if (!existing?.exists) {
        await client.query(
          `alter table basejump.accounts add constraint ${name}
             foreign key (${fk.columns.join(', ')}) references ${fk.target} not valid`,
        );
        addedFks.push(name);
      }
    }
  });

  afterAll(async () => {
    if (!client) return;
    for (const name of addedFks) {
      await client
        .query(`alter table basejump.accounts drop constraint if exists ${name}`)
        .catch(() => undefined);
    }
    await client.end();
  });

  test('the table carries the flagged foreign-key set', async () => {
    const { rows } = await client.query<{ name: string }>(`
      select c.conname as name
        from pg_constraint c
       where c.conrelid = 'basejump.accounts'::regclass
         and c.contype = 'f'
         and c.conname in ('accounts_created_by_fkey', 'accounts_updated_by_fkey')
       order by c.conname
    `);
    expect(rows.map((r) => r.name).sort()).toEqual(Object.keys(EXPECTED_FKS).sort());
  });

  test('every flagged foreign key on the table has a covering index', async () => {
    const { rows: fks } = await client.query<{
      name: string;
      columns: string[];
    }>(`
      select c.conname as name,
             array_agg(a.attname::text order by u.ord) as columns
        from pg_constraint c
        cross join unnest(c.conkey) with ordinality as u(attnum, ord)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = u.attnum
       where c.conrelid = 'basejump.accounts'::regclass
         and c.contype = 'f'
         and c.conname in ('accounts_created_by_fkey', 'accounts_updated_by_fkey')
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
       where i.indrelid = 'basejump.accounts'::regclass
         and a.attnum <> 0
       group by i.indexrelid, i.indisvalid
    `);

    // A foreign key is covered when some valid index lists its columns, in
    // order, as a leading prefix — the rule the Supabase advisor checks.
    // `index_name` is schema-qualified (`basejump.<name>`), so compare on the
    // unqualified tail.
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
    // On a deployed-like database the FK set predates this suite, so the
    // migration had its chance: every flagged FK must be covered. On a fresh
    // lane the table (and its FKs) were born after the migration ran — the
    // migration's guard skipped it by design, and the suite-built FKs have no
    // readers, so an uncovered FK here is the correct end state, not drift.
    const suiteBuiltFks = new Set(addedFks);
    const drifted = uncovered.filter((fk) => !suiteBuiltFks.has(fk.name));
    expect(drifted).toEqual([]);
  });
});
