/**
 * `kortix.sandbox_members` has a primary key.
 *
 * The Supabase performance advisor flagged `no_primary_key` on this table:
 * it is the only base table in the `kortix` schema with no primary-key
 * constraint (it kept a unique index on (sandbox_id, user_id) instead).
 * Reads the live catalog (`pg_constraint` / `pg_class`), never source text;
 * mirrors `account-secret-resources-fk-index.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('kortix.sandbox_members has a primary key', () => {
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

  test('the table carries the primary key on (sandbox_id, user_id)', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{
        name: string;
        columns: string[];
        validated: boolean;
      }>(`
        select c.conname as name,
               array_agg(a.attname::text order by u.ord) as columns,
               c.convalidated as validated
          from pg_constraint c
          cross join unnest(c.conkey) with ordinality as u(attnum, ord)
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = u.attnum
         where c.conrelid = 'kortix.sandbox_members'::regclass
           and c.contype = 'p'
         group by c.conname, c.convalidated
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('sandbox_members_pkey');
      expect(rows[0].columns).toEqual(['sandbox_id', 'user_id']);
      expect(rows[0].validated).toBe(true);
    });
  });

  test('the advisor no_primary_key lint no longer lists the table', async () => {
    await withClient(async (client) => {
      // The advisor's lint: every base table in a user schema that has no
      // primary-key constraint. The assertion is scoped to this table — the
      // lint may still list other tables with their own findings.
      const { rows } = await client.query<{ table_name: string }>(`
        select c.relname as table_name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where c.relkind = 'r'
           and n.nspname not in (
             'pg_catalog', 'information_schema', 'auth', 'realtime',
             'extensions', 'graphql', 'graphql_current', 'storage',
             'supabase_functions', 'supabase_realtime', 'pgsodium',
             'pgtle', 'vault'
           )
           and n.nspname not like 'pg_toast%'
           and not exists (
             select 1 from pg_constraint pc
              where pc.conrelid = c.oid and pc.contype = 'p'
           )
      `);
      expect(rows.map((r) => r.table_name)).not.toContain('sandbox_members');
    });
  });

  test('the primary key reuses the former unique index — no duplicate index', async () => {
    await withClient(async (client) => {
      // ADD CONSTRAINT ... PRIMARY KEY USING INDEX renames the existing
      // idx_sandbox_members_unique to the constraint's name, so the table
      // must end with exactly one unique index on (sandbox_id, user_id):
      // the primary key's own.
      const { rows } = await client.query<{ indexname: string; indisprimary: boolean }>(`
        select i.relname as indexname, ix.indisprimary as indisprimary
          from pg_class t
          join pg_index ix on ix.indrelid = t.oid
          join pg_class i on i.oid = ix.indexrelid
          join pg_namespace n on n.oid = t.relnamespace
         where t.relname = 'sandbox_members' and n.nspname = 'kortix'
           and ix.indisunique
           and (select array_agg(a.attname::text order by k.ord)
                  from unnest(ix.indkey) with ordinality as k(attnum, ord)
                  join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
               ) = array['sandbox_id', 'user_id']
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0].indexname).toBe('sandbox_members_pkey');
      expect(rows[0].indisprimary).toBe(true);
    });
  });
});
