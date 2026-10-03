/**
 * The two unused indexes the Supabase performance advisor flags on
 * `kortix.oauth_authorization_codes` are dropped by the migration, and
 * nothing else on the table is.
 *
 * The advisor reports `unused_index` on `kortix.oauth_authorization_codes` for
 * `idx_oauth_codes_client` (client_id) and `idx_oauth_codes_expires`
 * (expires_at). The only client_id-filtered read — the code-exchange lookup
 * (apps/api/src/oauth/index.ts:816, WHERE code = ? AND client_id = ?) — is
 * served by the unique `idx_oauth_codes_code`, and no reader filters
 * expires_at. The migration
 * `20261003122811000_drop_unused_oauth_codes_indexes.concurrent.ts` drops both
 * with `DROP INDEX CONCURRENTLY IF EXISTS`.
 *
 * A lane database has already applied every migration, so the migration's own
 * drop already ran there. The setup below rebuilds the production pre-state
 * (recreates the two target indexes), applies the migration's statements for
 * real (CONCURRENTLY — outside any transaction), and asserts the live catalog:
 * the two targets are gone, the kept indexes survive, and a re-run is a
 * no-op. Reads `pg_indexes`, never source text, so the assertion can never
 * pass vacuously.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const TARGET_INDEXES = ['idx_oauth_codes_client', 'idx_oauth_codes_expires'];
const KEPT_INDEXES = ['idx_oauth_codes_code', 'oauth_authorization_codes_pkey'];

/** The migration's exact statements (CONCURRENTLY cannot run in a transaction). */
const DROP_STATEMENTS = [
  "set lock_timeout = '180s'",
  'drop index concurrently if exists kortix.idx_oauth_codes_client',
  'drop index concurrently if exists kortix.idx_oauth_codes_expires',
];

suite('drop_unused_oauth_codes_indexes migration drops exactly the two unused indexes', () => {
  let client: pg.Client;

  const indexesOnTable = async (): Promise<string[]> => {
    const { rows } = await client.query(
      `select indexname from pg_indexes
         where schemaname = 'kortix' and tablename = 'oauth_authorization_codes'
         order by indexname`,
    );
    return rows.map((r) => r.indexname as string);
  };

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    // The lane's migrated database has no oauth_authorization_codes indexes
    // beyond pkey and the unique code index (the migration already ran in the
    // chain). Recreate the production pre-state: the two target indexes.
    for (const name of TARGET_INDEXES) {
      await client.query(`drop index concurrently if exists kortix."${name}"`);
      await client.query(
        `create index "${name}" on kortix.oauth_authorization_codes using btree (${name === 'idx_oauth_codes_client' ? 'client_id' : 'expires_at'})`,
      );
    }
  });

  test('after the migration statements, exactly the kept indexes remain', async () => {
    for (const statement of DROP_STATEMENTS) {
      await client.query(statement);
    }
    const remaining = await indexesOnTable();
    expect(remaining.sort()).toEqual([...KEPT_INDEXES].sort());
  });

  test('a re-run of both statements is a no-op (IF EXISTS)', async () => {
    const before = await indexesOnTable();
    for (const statement of DROP_STATEMENTS) {
      await client.query(statement);
    }
    expect(await indexesOnTable()).toEqual(before);
  });

  afterAll(async () => {
    await client.end();
  });
});
