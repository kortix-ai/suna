import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;

/**
 * Every foreign key on kortix.account_secret_grants must have a covering
 * index: an index whose leading key columns equal the FK's columns in order.
 * That is the exact rule of the Supabase `unindexed_foreign_keys` lint
 * (supabase/splinter 0001), which the prod advisor runs; without it the lint
 * fires and a cascade delete of an account_secret_resources or
 * account_memberships row scans this table (KRTX-1089).
 *
 * The query is the lint itself, scoped to this one table: a schema-wide run
 * would fail on other tables' findings, which other issues own.
 */
describe.skipIf(!databaseUrl)('account_secret_grants FK covering indexes', () => {
  test('the unindexed_foreign_keys lint returns no row for the table', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const { rows } = await client.query(`
        with foreign_keys as (
            select
                ns.nspname as schema_name,
                cl.relname as table_name,
                cl.oid as table_oid,
                ct.conname as fkey_name,
                ct.conkey as col_attnums
            from
                pg_catalog.pg_constraint ct
                join pg_catalog.pg_class cl on ct.conrelid = cl.oid
                join pg_catalog.pg_namespace ns on cl.relnamespace = ns.oid
                left join pg_catalog.pg_depend d
                    on d.objid = cl.oid and d.deptype = 'e'
                    and d.classid = 'pg_catalog.pg_class'::regclass
            where
                ct.contype = 'f' and d.objid is null
                and ns.nspname not in (
                    'pg_catalog', 'information_schema', 'auth', 'storage', 'vault', 'extensions'
                )
        ),
        index_ as (
            select
                pi.indrelid as table_oid,
                indexrelid::regclass as index_,
                string_to_array(indkey::text, ' ')::smallint[] as col_attnums
            from pg_catalog.pg_index pi
            where indisvalid
        )
        select fk.fkey_name, fk.col_attnums
        from foreign_keys fk
            left join index_ idx
                on fk.table_oid = idx.table_oid
                and fk.col_attnums = idx.col_attnums[1:array_length(fk.col_attnums, 1)]
            left join pg_catalog.pg_depend dep
                on idx.table_oid = dep.objid and dep.deptype = 'e'
                and dep.classid = 'pg_catalog.pg_class'::regclass
        where idx.index_ is null and dep.objid is null
          and fk.schema_name = 'kortix'
          and fk.table_name = 'account_secret_grants'
        order by fk.fkey_name
      `);
      expect(rows).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
