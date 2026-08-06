import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.CONNECTOR_CUTOVER_DATABASE_URL;

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ID = '22222222-2222-2222-2222-222222222222';
const CONNECTOR_ID = '33333333-3333-3333-3333-333333333333';
const OLD_CONNECTION_ID = '44444444-4444-4444-4444-444444444444';
const NEW_CONNECTION_ID = '55555555-5555-5555-5555-555555555555';
const INVALID_CONNECTION_ID = '66666666-6666-6666-6666-666666666666';
const SESSION_ID = 'connector-physical-cutover-test';

describe.skipIf(!databaseUrl)('connector physical cutover — migrated PostgreSQL', () => {
  test('preserves old and canonical writers while synchronizing binding identifiers', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');

    try {
      await client.query(
        `INSERT INTO kortix.accounts (account_id, name) VALUES ($1, 'Connector cutover test')`,
        [ACCOUNT_ID],
      );
      await client.query(
        `INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
         VALUES ($1, $2, 'Connector cutover', 'https://example.invalid/cutover')`,
        [PROJECT_ID, ACCOUNT_ID],
      );
      await client.query(
        `INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name)
         VALUES ($1, $2, $3, $1)`,
        [SESSION_ID, ACCOUNT_ID, PROJECT_ID],
      );

      await client.query(
        `INSERT INTO kortix.executor_connectors
           (connector_id, account_id, project_id, slug, name, provider_type)
         VALUES ($1, $2, $3, 'cutover-test', 'Cutover test', 'mcp')`,
        [CONNECTOR_ID, ACCOUNT_ID, PROJECT_ID],
      );
      await client.query(
        `INSERT INTO kortix.executor_connection_profiles
           (profile_id, account_id, project_id, connector_id, label)
         VALUES ($1, $2, $3, $4, 'Old writer')`,
        [OLD_CONNECTION_ID, ACCOUNT_ID, PROJECT_ID, CONNECTOR_ID],
      );
      await client.query(
        `INSERT INTO kortix.connector_connections
           (connection_id, account_id, project_id, connector_id, label)
         VALUES ($1, $2, $3, $4, 'Canonical writer')`,
        [NEW_CONNECTION_ID, ACCOUNT_ID, PROJECT_ID, CONNECTOR_ID],
      );

      const canonicalConnector = await client.query(
        `SELECT connector_id FROM kortix.connectors WHERE connector_id = $1`,
        [CONNECTOR_ID],
      );
      expect(canonicalConnector.rowCount).toBe(1);

      const legacyConnection = await client.query(
        `SELECT profile_id FROM kortix.executor_connection_profiles WHERE profile_id = $1`,
        [NEW_CONNECTION_ID],
      );
      expect(legacyConnection.rowCount).toBe(1);

      await client.query(
        `INSERT INTO kortix.project_session_connector_bindings
           (session_id, account_id, project_id, connector_alias, connector_id, profile_id)
         VALUES ($1, $2, $3, 'cutover-test', $4, $5)`,
        [SESSION_ID, ACCOUNT_ID, PROJECT_ID, CONNECTOR_ID, OLD_CONNECTION_ID],
      );

      const oldWriterBinding = await client.query<{ profile_id: string; connection_id: string }>(
        `SELECT profile_id, connection_id
         FROM kortix.project_session_connector_bindings
         WHERE session_id = $1`,
        [SESSION_ID],
      );
      expect(oldWriterBinding.rows[0]).toEqual({
        profile_id: OLD_CONNECTION_ID,
        connection_id: OLD_CONNECTION_ID,
      });

      await client.query(
        `UPDATE kortix.project_session_connector_bindings
         SET connection_id = $2
         WHERE session_id = $1`,
        [SESSION_ID, NEW_CONNECTION_ID],
      );
      const canonicalWriterBinding = await client.query<{ profile_id: string; connection_id: string }>(
        `SELECT profile_id, connection_id
         FROM kortix.project_session_connector_bindings
         WHERE session_id = $1`,
        [SESSION_ID],
      );
      expect(canonicalWriterBinding.rows[0]).toEqual({
        profile_id: NEW_CONNECTION_ID,
        connection_id: NEW_CONNECTION_ID,
      });

      await client.query(
        `DO $test$
         DECLARE rejected boolean := false;
         BEGIN
           BEGIN
             UPDATE kortix.project_session_connector_bindings
             SET connection_id = '${OLD_CONNECTION_ID}', profile_id = '${INVALID_CONNECTION_ID}'
             WHERE session_id = '${SESSION_ID}';
           EXCEPTION WHEN check_violation THEN
             rejected := true;
           END;
           IF NOT rejected THEN
             RAISE EXCEPTION 'Conflicting connector connection identifiers did not fail closed';
           END IF;
         END
         $test$`,
      );
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  }, 30_000);
});
