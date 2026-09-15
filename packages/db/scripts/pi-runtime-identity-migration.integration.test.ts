import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode === 0;

const container = `kortix-pi-runtime-identity-${crypto.randomUUID().slice(0, 8)}`;

function dockerPsql(sql: string) {
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      'testdb',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) throw new Error(output);
  return output.trim();
}

describe.skipIf(!dockerAvailable)('Pi runtime identity migration — real PostgreSQL', () => {
  beforeAll(async () => {
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

    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const probe = Bun.spawnSync(
        ['docker', 'exec', container, 'psql', '-U', 'postgres', '-d', 'testdb', '-c', 'SELECT 1'],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (probe.exitCode === 0) {
        ready = true;
        break;
      }
      await Bun.sleep(250);
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready');

    dockerPsql(`
      CREATE SCHEMA kortix;
      CREATE TABLE kortix.account_tokens (
        token_id uuid PRIMARY KEY,
        session_id text
      );
      CREATE TABLE kortix.session_environments (
        session_id text PRIMARY KEY,
        external_id text
      );
      INSERT INTO kortix.account_tokens(token_id, session_id)
      VALUES ('00000000-0000-4000-a000-000000000001', 'session-1');
      INSERT INTO kortix.session_environments(session_id, external_id)
      VALUES ('session-1', 'provider-box-1');
    `);

    const migration = await Bun.file(
      resolve(import.meta.dir, '..', 'migrations', '20260903080719873_pi_runtime_identity.sql'),
    ).text();
    dockerPsql(migration);
  }, 30_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
  });

  test('preserves existing rows with nullable identities and no defaults', () => {
    const definitions = dockerPsql(`
      SELECT table_name || '.' || column_name || ':' || is_nullable || ':' || coalesce(column_default, 'NULL')
      FROM information_schema.columns
      WHERE table_schema = 'kortix'
        AND (table_name, column_name) IN (
          ('account_tokens', 'runtime_kind'),
          ('account_tokens', 'runtime_id'),
          ('session_environments', 'environment_id')
        )
      ORDER BY table_name, column_name;
    `);
    expect(definitions.split('\n')).toEqual([
      'account_tokens.runtime_id:YES:NULL',
      'account_tokens.runtime_kind:YES:NULL',
      'session_environments.environment_id:YES:NULL',
    ]);
    expect(
      dockerPsql(`
        SELECT runtime_kind IS NULL AND runtime_id IS NULL
        FROM kortix.account_tokens
        WHERE session_id = 'session-1';
      `),
    ).toBe('t');
    expect(
      dockerPsql(`
        SELECT environment_id IS NULL
        FROM kortix.session_environments
        WHERE session_id = 'session-1';
      `),
    ).toBe('t');
  });

  test('stores distinct worker and environment principals for one session', () => {
    dockerPsql(`
      UPDATE kortix.account_tokens
      SET runtime_kind = 'worker', runtime_id = '00000000-0000-4000-a000-000000000010'
      WHERE session_id = 'session-1';
      INSERT INTO kortix.account_tokens(token_id, session_id, runtime_kind, runtime_id)
      VALUES (
        '00000000-0000-4000-a000-000000000002',
        'session-1',
        'environment',
        '00000000-0000-4000-a000-000000000020'
      );
      UPDATE kortix.session_environments
      SET environment_id = '00000000-0000-4000-a000-000000000020'
      WHERE session_id = 'session-1';
    `);

    expect(
      dockerPsql(`
        SELECT runtime_kind || ':' || runtime_id
        FROM kortix.account_tokens
        WHERE session_id = 'session-1'
        ORDER BY runtime_kind;
      `).split('\n'),
    ).toEqual([
      'environment:00000000-0000-4000-a000-000000000020',
      'worker:00000000-0000-4000-a000-000000000010',
    ]);
    expect(
      dockerPsql(`
        SELECT environment_id
        FROM kortix.session_environments
        WHERE session_id = 'session-1';
      `),
    ).toBe('00000000-0000-4000-a000-000000000020');
  });
});
