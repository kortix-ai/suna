import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const client = new pg.Client({ connectionString: databaseUrl });

// The db-suites lane provides a fresh, fully migrated PostgreSQL database.
describe.skipIf(!databaseUrl)('OAuth authorization request client FK index', () => {
  beforeAll(() => client.connect());
  afterAll(() => client.end());

  test('the client foreign key has a valid, non-partial leading-column index', async () => {
    const result = await client.query<{ covered: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_index i
        WHERE i.indrelid = fk.conrelid
          AND i.indisvalid AND i.indisready
          AND i.indpred IS NULL AND i.indexprs IS NULL
          AND i.indkey[0] = fk.conkey[1]
      ) AS covered
      FROM pg_constraint fk
      WHERE fk.conrelid = 'kortix.oauth_authorization_requests'::regclass
        AND fk.conname = 'oauth_auth_requests_client_fk'
        AND fk.contype = 'f'
    `);
    expect(result.rows).toEqual([{ covered: true }]);
  });

  test('deleting a client still cascades to its authorization requests', async () => {
    await client.query('BEGIN');
    try {
      const parent = await client.query<{ client_id: string }>(`
        INSERT INTO kortix.oauth_clients (client_secret_hash, name)
        VALUES ('synthetic-hash', 'index-regression') RETURNING client_id
      `);
      const clientId = parent.rows[0]?.client_id;
      expect(clientId).toBeDefined();
      await client.query(
        `
        INSERT INTO kortix.oauth_authorization_requests
          (client_id, request_id_hash, redirect_uri, code_challenge, expires_at)
        VALUES ($1, 'synthetic-request', 'https://example.test/callback', 'synthetic-challenge', now() + interval '5 minutes')
      `,
        [clientId],
      );
      const before = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM kortix.oauth_authorization_requests WHERE client_id = $1',
        [clientId],
      );
      expect(before.rows).toEqual([{ count: 1 }]);
      await client.query('DELETE FROM kortix.oauth_clients WHERE client_id = $1', [clientId]);
      const after = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM kortix.oauth_authorization_requests WHERE client_id = $1',
        [clientId],
      );
      expect(after.rows).toEqual([{ count: 0 }]);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
