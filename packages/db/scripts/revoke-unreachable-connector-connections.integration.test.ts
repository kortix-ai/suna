/**
 * The strategy-retirement revocation, against a real PostgreSQL.
 *
 * `connectorAuthorizationMatchesStrategy` is being replaced by a per-row
 * reachability rule, which makes rows the connector-level flag had been hiding
 * callable. The migration revokes exactly the hidden rows that hold a real
 * credential, and nothing else. That "and nothing else" is the part worth a
 * test: over-revoking takes a working shared account away from a whole project.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode === 0;

const container = `kortix-revoke-unreachable-${crypto.randomUUID().slice(0, 8)}`;
const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_revoke_unreachable_connector_connections.sql').scanSync({
    cwd: migrationDirectory,
  }),
);
let containerStarted = false;

function dockerPsql(sql: string) {
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      container,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      'postgres',
      '-d',
      'testdb',
      '-v',
      'ON_ERROR_STOP=1',
      '-t',
      '-A',
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) throw new Error(output);
  return output.trim();
}

/** The three columns of `kortix.connectors` + `connector_connections` the
 *  migration reads, and nothing else — a fixture, not a schema mirror. */
const SCHEMA = `
  CREATE SCHEMA kortix;
  CREATE TABLE kortix.connectors (
    connector_id uuid PRIMARY KEY,
    authorization_strategy text NOT NULL
  );
  CREATE TABLE kortix.connector_connections (
    connection_id uuid PRIMARY KEY,
    connector_id uuid NOT NULL REFERENCES kortix.connectors(connector_id),
    owner_type text NOT NULL,
    is_default boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'active',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connector_id, connection_id)
  );
  CREATE TABLE kortix.connection_credentials (
    credential_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id uuid NOT NULL,
    connection_id uuid
  );
`;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const USER_CONNECTOR = uuid(1);
const PROJECT_CONNECTOR = uuid(2);
const LEGACY_CONNECTOR = uuid(3);

// connection ids, named for what each one proves
const HIDDEN_SHARED_WITH_CREDENTIAL = uuid(10);
const HIDDEN_SHARED_EMPTY = uuid(11);
const HIDDEN_SHARED_WITH_COMPOSIO_ACCOUNT = uuid(12);
const HIDDEN_PRIVATE_WITH_CREDENTIAL = uuid(13);
const REACHABLE_SHARED_WITH_CREDENTIAL = uuid(14);
const REACHABLE_PRIVATE_WITH_CREDENTIAL = uuid(15);
const HIDDEN_SHARED_DEFAULT_LEGACY_CREDENTIAL = uuid(16);

const FIXTURE = `
  INSERT INTO kortix.connectors (connector_id, authorization_strategy) VALUES
    ('${USER_CONNECTOR}', 'user'),
    ('${PROJECT_CONNECTOR}', 'project'),
    ('${LEGACY_CONNECTOR}', 'user');

  INSERT INTO kortix.connector_connections
    (connection_id, connector_id, owner_type, is_default, status, metadata) VALUES
    -- unreachable on a 'user' connector, holds a per-connection credential
    ('${HIDDEN_SHARED_WITH_CREDENTIAL}', '${USER_CONNECTOR}', 'project', true, 'active', '{}'),
    -- unreachable, empty placeholder: must stay ACTIVE
    ('${HIDDEN_SHARED_EMPTY}', '${USER_CONNECTOR}', 'project', false, 'active', '{}'),
    -- unreachable, authorized Composio account but no credential row
    ('${HIDDEN_SHARED_WITH_COMPOSIO_ACCOUNT}', '${USER_CONNECTOR}', 'project', false, 'active',
     '{"connected_account_id":"ca_123"}'),
    -- unreachable on a 'project' connector (member-owned), holds a credential
    ('${HIDDEN_PRIVATE_WITH_CREDENTIAL}', '${PROJECT_CONNECTOR}', 'member', true, 'active', '{}'),
    -- reachable today: the shared account of a 'project' connector
    ('${REACHABLE_SHARED_WITH_CREDENTIAL}', '${PROJECT_CONNECTOR}', 'project', true, 'active', '{}'),
    -- reachable today: a member's own account on a 'user' connector
    ('${REACHABLE_PRIVATE_WITH_CREDENTIAL}', '${USER_CONNECTOR}', 'member', true, 'active', '{}'),
    -- unreachable default that would serve the connector-wide legacy credential
    ('${HIDDEN_SHARED_DEFAULT_LEGACY_CREDENTIAL}', '${LEGACY_CONNECTOR}', 'project', true, 'active', '{}');

  INSERT INTO kortix.connection_credentials (connector_id, connection_id) VALUES
    ('${USER_CONNECTOR}', '${HIDDEN_SHARED_WITH_CREDENTIAL}'),
    ('${PROJECT_CONNECTOR}', '${HIDDEN_PRIVATE_WITH_CREDENTIAL}'),
    ('${PROJECT_CONNECTOR}', '${REACHABLE_SHARED_WITH_CREDENTIAL}'),
    ('${USER_CONNECTOR}', '${REACHABLE_PRIVATE_WITH_CREDENTIAL}'),
    -- the legacy connector-wide credential: no connection_id
    ('${LEGACY_CONNECTOR}', NULL);
`;

function statuses(): string {
  return dockerPsql(`
    SELECT connection_id || ':' || status
      FROM kortix.connector_connections
     ORDER BY connection_id;
  `);
}

describe.skipIf(!dockerAvailable)(
  'revoke unreachable connector connections migration — real PostgreSQL',
  () => {
    beforeAll(async () => {
      if (migrationNames.length !== 1) return;
      const started = Bun.spawnSync([
        'docker',
        'run',
        '--rm',
        '-d',
        '--name',
        container,
        '-e',
        'POSTGRES_PASSWORD=test',
        '-e',
        'POSTGRES_DB=testdb',
        'postgres:16-alpine',
      ]);
      if (started.exitCode !== 0) throw new Error(started.stderr.toString());
      containerStarted = true;

      for (let attempt = 0; attempt < 50; attempt += 1) {
        // TCP, never the unix socket: initdb runs a temporary socket-only
        // server whose readiness says nothing about the real one.
        const probe = Bun.spawnSync(
          [
            'docker',
            'exec',
            container,
            'psql',
            '-h',
            '127.0.0.1',
            '-U',
            'postgres',
            '-d',
            'testdb',
            '-c',
            'SELECT 1',
          ],
          { stdout: 'ignore', stderr: 'ignore' },
        );
        if (probe.exitCode === 0) {
          dockerPsql(`${SCHEMA}${FIXTURE}`);
          return;
        }
        await Bun.sleep(250);
      }
      throw new Error('Disposable PostgreSQL did not become ready');
    }, 60_000);

    afterAll(() => {
      if (!containerStarted) return;
      Bun.spawnSync(['docker', 'rm', '-f', container], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
    });

    test('revokes only the hidden connections that hold an identity, and is idempotent', async () => {
      expect(migrationNames).toHaveLength(1);
      const migration = await Bun.file(resolve(migrationDirectory, migrationNames[0]!)).text();

      dockerPsql(migration);

      const expected = [
        `${HIDDEN_SHARED_WITH_CREDENTIAL}:revoked`,
        `${HIDDEN_SHARED_EMPTY}:active`,
        `${HIDDEN_SHARED_WITH_COMPOSIO_ACCOUNT}:revoked`,
        `${HIDDEN_PRIVATE_WITH_CREDENTIAL}:revoked`,
        `${REACHABLE_SHARED_WITH_CREDENTIAL}:active`,
        `${REACHABLE_PRIVATE_WITH_CREDENTIAL}:active`,
        `${HIDDEN_SHARED_DEFAULT_LEGACY_CREDENTIAL}:revoked`,
      ]
        .sort()
        .join('\n');
      expect(statuses()).toBe(expected);

      // A second apply matches nothing: `status <> 'revoked'` is the guard, and
      // deploys re-run migrations after a failed batch.
      const before = dockerPsql(
        `SELECT max(updated_at)::text FROM kortix.connector_connections WHERE status = 'revoked';`,
      );
      await Bun.sleep(1100);
      dockerPsql(migration);
      expect(statuses()).toBe(expected);
      expect(
        dockerPsql(
          `SELECT max(updated_at)::text FROM kortix.connector_connections WHERE status = 'revoked';`,
        ),
      ).toBe(before);
    }, 60_000);
  },
);
