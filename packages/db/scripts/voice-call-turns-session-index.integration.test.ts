/**
 * `kortix.voice_call_turns` carries exactly the indexes the committed
 * migrations build: the identity primary key plus the call+cursor hot-read
 * index. The `(session_id, cursor)` index was never read (Supabase advisor
 * `unused_index`; pg_stat_user_indexes.idx_scan = 0 over an unbroken stats
 * window) and
 * 20261003061615226_drop_voice_call_turns_session_index.concurrent.ts drops
 * it. Reads the live catalog, never source text; mirrors
 * `account-secret-resources-fk-index.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** The index set the committed migrations must leave on the table. */
const EXPECTED_INDEXES = ['idx_voice_call_turns_call_cursor', 'voice_call_turns_pkey'];

suite('kortix.voice_call_turns carries exactly the committed indexes', () => {
  test('the session index is gone and every remaining index is valid', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ name: string; valid: boolean }>(`
        select s.indexrelname as name, i.indisvalid as valid
          from pg_stat_user_indexes s
          join pg_index i on i.indexrelid = s.indexrelid
         where s.schemaname = 'kortix' and s.relname = 'voice_call_turns'
         order by s.indexrelname
      `);
      expect(rows.map((r) => r.name)).toEqual(EXPECTED_INDEXES);
      expect(rows.every((r) => r.valid)).toBe(true);
    } finally {
      await client.end();
    }
  });
});
