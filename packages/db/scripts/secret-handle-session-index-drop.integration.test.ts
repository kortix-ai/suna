import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const TABLE = 'kortix.project_session_secret_handles';

// 20260728132613912_secret_delivery_indexes.concurrent.ts built four indexes on
// the table. 20261003060306058_drop_unused_secret_handle_session_index
// .concurrent.ts drops the one the Supabase advisor reports unused
// (`unused_index` on kortix.project_session_secret_handles): the non-unique
// idx_secret_handles_session (session_id). The other three stay, and the
// session_id foreign key must stay covered: Postgres resolves a delete/update
// on the referenced row through a valid, non-partial index on the referencing
// table leading with the FK column, and idx_secret_handles_session_secret_rev
// (session_id, secret_id, revision) is that index after the drop.
const DROPPED = 'idx_secret_handles_session';
const REMAINING = [
  'idx_secret_handles_lookup',
  'idx_secret_handles_session_secret_rev',
  'idx_secret_handles_one_active',
];

describe.skipIf(!databaseUrl)('kortix.project_session_secret_handles — unused session index drop', () => {
  test('idx_secret_handles_session is dropped; the three used indexes remain valid', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ indexname: string; indisvalid: boolean }>(
        `SELECT s.indexrelname AS indexname, i.indisvalid
           FROM pg_stat_user_indexes s
           JOIN pg_index i ON i.indexrelid = s.indexrelid
          WHERE s.schemaname = 'kortix'
            AND s.relname = 'project_session_secret_handles'`,
      );
      const names = rows.map((r) => r.indexname);
      expect(names).not.toContain(DROPPED);
      expect(names.filter((n) => REMAINING.includes(n)).sort()).toEqual([...REMAINING].sort());
      expect(rows.filter((r) => REMAINING.includes(r.indexname) && !r.indisvalid)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('the session_id foreign key stays covered by a full, valid index', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      // pg_index.indkey is a 0-based int2vector and the cast keeps that lower
      // bound, so normalize to 1-based before the prefix compare. Session_id is
      // attnum 3 of the table (handle_id, project_id, session_id, ...).
      const { rows } = await client.query<{ covered: number }>(
        `SELECT count(*)::int AS covered
           FROM pg_constraint c
           JOIN pg_attribute a
             ON a.attrelid = c.conrelid AND a.attname = 'session_id'
          WHERE c.conrelid = $1::regclass
            AND c.contype = 'f'
            AND c.conkey[1] = a.attnum
            AND EXISTS (
              SELECT 1 FROM pg_index i
               WHERE i.indrelid = c.conrelid
                 AND i.indisvalid
                 AND i.indpred IS NULL
                 AND (ARRAY(SELECT unnest(i.indkey::int2[])))[1] = a.attnum
            )`,
        [TABLE],
      );
      expect(rows[0].covered).toBe(1);
    } finally {
      await client.end();
    }
  });
});
