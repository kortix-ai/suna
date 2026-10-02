import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const TABLE = 'kortix.project_session_secret_handles';
// The three FKs 20260728132613911_secret_delivery_strategy.sql adds.
const FK_NAMES = [
  'project_session_secret_handles_project_id_fk',
  'project_session_secret_handles_session_id_fk',
  'project_session_secret_handles_secret_id_fk',
];

// A foreign key needs an index on the referencing table whose leading key
// columns are the FK columns: a delete or update on the referenced row finds
// the referencing rows with it, and seq-scans the table without it (the
// Supabase advisor's unindexed_foreign_keys lint). A partial index does not
// serve the RI query (its predicate does not imply `WHERE fk_col = $1`), so it
// must be full, and INVALID does not serve anything.
describe.skipIf(!databaseUrl)('kortix.project_session_secret_handles — FK covering indexes', () => {
  test('every foreign key has a valid, non-partial index leading with its columns', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      // pg_index.indkey is a 0-based int2vector and the cast keeps that lower
      // bound, so normalize both arrays to 1-based before the prefix compare.
      const { rows } = await client.query<{ conname: string; covered: boolean }>(
        `WITH fks AS (
           SELECT c.conname, ARRAY(SELECT unnest(c.conkey)) AS fk_cols,
                  array_length(c.conkey, 1) AS n
             FROM pg_constraint c
            WHERE c.conrelid = $1::regclass AND c.contype = 'f'
         )
         SELECT f.conname,
                EXISTS (
                  SELECT 1 FROM pg_index i
                   WHERE i.indrelid = $1::regclass
                     AND i.indisvalid
                     AND i.indpred IS NULL
                     AND (ARRAY(SELECT unnest(i.indkey::int2[])))[1:f.n] = f.fk_cols
                ) AS covered
           FROM fks f
          ORDER BY f.conname`,
        [TABLE],
      );
      expect(rows.map((r) => r.conname).sort()).toEqual([...FK_NAMES].sort());
      expect(rows.filter((r) => !r.covered).map((r) => r.conname)).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
