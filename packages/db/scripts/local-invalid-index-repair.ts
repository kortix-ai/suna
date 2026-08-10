import pg from 'pg';

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Remove unusable indexes left by failed CREATE INDEX CONCURRENTLY attempts.
 * A pending migration can then rebuild each index instead of accepting the
 * invalid relation through IF NOT EXISTS.
 */
export async function dropLocalInvalidIndexes(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const activeBuilds = await client.query<{ count: number }>(
      'select count(*)::int as count from pg_stat_progress_create_index',
    );
    if ((activeBuilds.rows[0]?.count ?? 0) > 0) {
      throw new Error('Cannot repair local invalid indexes while an index build is active.');
    }

    const invalid = await client.query<{ schema_name: string; index_name: string }>(`
      select n.nspname as schema_name, c.relname as index_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_index i on i.indexrelid = c.oid
       where n.nspname = 'kortix'
         and not i.indisvalid
       order by c.relname
    `);
    if (invalid.rows.length === 0) return [];

    await client.query('begin');
    try {
      await client.query("set local lock_timeout = '5s'");
      for (const row of invalid.rows) {
        await client.query(
          `drop index if exists ${quoteIdentifier(row.schema_name)}.${quoteIdentifier(row.index_name)}`,
        );
      }
      await client.query('commit');
      return invalid.rows.map((row) => `${row.schema_name}.${row.index_name}`);
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  } finally {
    await client.end();
  }
}
