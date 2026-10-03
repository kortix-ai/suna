import { describe, expect, test } from 'bun:test';
import pg from 'pg';

/**
 * The Supabase advisor (lint 0001_unindexed_foreign_keys) must find no
 * unindexed foreign key on `kortix.session_tool_approvals`.
 *
 * Both FK columns (`project_id`, `connector_id`) are covered by an index that
 * LEADS with them — the advisor's join condition is ordered equality between
 * the FK columns and an index's leading columns (supabase/splinter
 * lints/0001_unindexed_foreign_keys.sql). The UNIQUE constraint on
 * (session_id, connector_id, action_path) leads with session_id, so it covers
 * neither FK — before `20261003045230000_session_tool_approvals_fk_indexes`
 * the advisor reported both FKs (live prod read, 2026-10-02).
 *
 * The db-suites lane supplies TEST_DATABASE_URL: a fresh clone of the migrated
 * template. Without the env (a direct `bun test` outside the lane) the suite
 * is skipped, like every other lane-DB suite here.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const TABLE = 'session_tool_approvals';

/** The advisor's exact condition, scoped to the one table. */
const UNINDEXED_FKS = `
  with foreign_keys as (
    select cl.oid as table_oid, ct.conname as fkey_name, ct.conkey as col_attnums
    from pg_catalog.pg_constraint ct
      join pg_catalog.pg_class cl on ct.conrelid = cl.oid
      join pg_catalog.pg_namespace ns on cl.relnamespace = ns.oid
    where ct.contype = 'f'
      and ns.nspname = 'kortix'
      and cl.relname = $1
  ),
  index_ as (
    select pi.indrelid as table_oid,
           string_to_array(pi.indkey::text, ' ')::smallint[] as col_attnums
    from pg_catalog.pg_index pi
    where pi.indisvalid
  )
  select fk.fkey_name, fk.col_attnums
  from foreign_keys fk
  left join index_ idx
    on fk.table_oid = idx.table_oid
    and fk.col_attnums = idx.col_attnums[1:array_length(fk.col_attnums, 1)]
  where idx.table_oid is null
  order by fk.fkey_name
`;

interface FkRow {
  fkey_name: string;
  col_attnums: number[];
}

suite('session_tool_approvals foreign keys are advisor-covered — real PostgreSQL', () => {
  test('no FK of kortix.session_tool_approvals lacks a leading covering index', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const unindexed = await client.query<FkRow>(UNINDEXED_FKS, [TABLE]);
      expect(unindexed.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('the two covering indexes exist and are valid', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{
        indexname: string;
        indisvalid: boolean;
        indkey: string;
      }>(
        `select c.relname as indexname, i.indisvalid, i.indkey::text
         from pg_catalog.pg_index i
           join pg_catalog.pg_class c on c.oid = i.indexrelid
           join pg_catalog.pg_class t on t.oid = i.indrelid
           join pg_catalog.pg_namespace n on n.oid = t.relnamespace
         where n.nspname = 'kortix' and t.relname = $1
         order by c.relname`,
        [TABLE],
      );
      const project = rows.find((row) => row.indexname === 'idx_session_tool_approvals_project_id');
      const connector = rows.find(
        (row) => row.indexname === 'idx_session_tool_approvals_connector_id',
      );
      expect(project?.indisvalid).toBe(true);
      expect(project?.indkey.split(' ')[0]).toBe('3'); // attnum of project_id
      expect(connector?.indisvalid).toBe(true);
      expect(connector?.indkey.split(' ')[0]).toBe('4'); // attnum of connector_id
    } finally {
      await client.end();
    }
  });
});
