import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode === 0;

const container = `kortix-runtime-identity-${crypto.randomUUID().slice(0, 8)}`;

function dockerPsql(sql: string, allowFailure = false) {
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
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (!allowFailure && result.exitCode !== 0) throw new Error(output);
  return { exitCode: result.exitCode, output };
}

describe.skipIf(!dockerAvailable)('runtime identity migration — real PostgreSQL', () => {
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

    const migrationDir = resolve(import.meta.dir, '..', 'migrations');
    const migrations = await Promise.all(
      [
        '20260711210000000_session_sandbox_identity_immutability.sql',
        '20260712200000000_allow_missing_runtime_recovery.sql',
        '20260712210000000_revoke_automatic_runtime_identity_recovery.sql',
      ].map((name) => Bun.file(resolve(migrationDir, name)).text()),
    );

    dockerPsql(`
      CREATE SCHEMA kortix;
      CREATE TABLE kortix.project_sessions (
        session_id uuid PRIMARY KEY,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE kortix.session_sandboxes (
        session_id uuid NOT NULL,
        external_id text,
        provider text NOT NULL,
        status text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      ${migrations.join('\n')}
      INSERT INTO kortix.project_sessions(session_id) VALUES
        ('00000000-0000-4000-a000-000000000001'),
        ('00000000-0000-4000-a000-000000000002');
      INSERT INTO kortix.session_sandboxes(session_id, external_id, provider, status, metadata) VALUES
        ('00000000-0000-4000-a000-000000000001', 'sbx_original', 'platinum', 'active', '{}'),
        ('00000000-0000-4000-a000-000000000002', NULL, 'platinum', 'provisioning', '{}');
    `);
  }, 30_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
  });

  test('blocks direct replacement and provider swaps', () => {
    for (const statement of [
      `UPDATE kortix.session_sandboxes SET external_id = 'sbx_replacement' WHERE session_id = '00000000-0000-4000-a000-000000000001'`,
      `UPDATE kortix.session_sandboxes SET provider = 'daytona' WHERE session_id = '00000000-0000-4000-a000-000000000001'`,
      `UPDATE kortix.session_sandboxes SET external_id = NULL, status = 'provisioning', metadata = '{"identityRecoveryAuthorizedAt":"stale"}' WHERE session_id = '00000000-0000-4000-a000-000000000001'`,
    ]) {
      const result = dockerPsql(`\\set VERBOSITY verbose\n${statement};`, true);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('23514');
    }
  });

  test('blocks stale deletion markers and allows only explicit session deletion', () => {
    dockerPsql(`
      UPDATE kortix.session_sandboxes
         SET metadata = '{"identityDeletionAuthorizedAt":"stale"}'
       WHERE session_id = '00000000-0000-4000-a000-000000000001';
    `);
    const blocked = dockerPsql(
      `
      \\set VERBOSITY verbose
      DELETE FROM kortix.session_sandboxes
       WHERE session_id = '00000000-0000-4000-a000-000000000001';
    `,
      true,
    );
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.output).toContain('23514');

    dockerPsql(`
      UPDATE kortix.project_sessions
         SET metadata = '{"deletedAt":"2026-07-12T00:00:00Z"}'
       WHERE session_id = '00000000-0000-4000-a000-000000000001';
      DELETE FROM kortix.session_sandboxes
       WHERE session_id = '00000000-0000-4000-a000-000000000001';
      DELETE FROM kortix.session_sandboxes
       WHERE session_id = '00000000-0000-4000-a000-000000000002';
    `);
    expect(dockerPsql('SELECT count(*) FROM kortix.session_sandboxes;').output).toContain('0');
  });
});
