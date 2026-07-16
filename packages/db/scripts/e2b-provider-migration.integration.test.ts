import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;

const container = `kortix-e2b-provider-migration-${crypto.randomUUID().slice(0, 8)}`;

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
      '-t',
      '-A',
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (!allowFailure && result.exitCode !== 0) throw new Error(output);
  return { exitCode: result.exitCode, output };
}

const PRE_MIGRATION_SCHEMA = `
  CREATE SCHEMA kortix;
  CREATE TYPE kortix.sandbox_provider AS ENUM ('daytona', 'platinum', 'managed');

  CREATE TABLE kortix.sandboxes (
    sandbox_id uuid PRIMARY KEY,
    provider kortix.sandbox_provider NOT NULL DEFAULT 'daytona'
  );

  CREATE TABLE kortix.project_sessions (
    session_id text PRIMARY KEY,
    sandbox_provider kortix.sandbox_provider NOT NULL DEFAULT 'daytona',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
  );

  CREATE TABLE kortix.session_sandboxes (
    sandbox_id uuid PRIMARY KEY,
    session_id text NOT NULL REFERENCES kortix.project_sessions(session_id),
    provider kortix.sandbox_provider NOT NULL DEFAULT 'daytona',
    external_id text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
  );

  CREATE TABLE kortix.sandbox_compute_sessions (
    id uuid PRIMARY KEY,
    sandbox_id uuid NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now()
  );
`;

describe.skipIf(!dockerAvailable)('E2B provider-set migration — real PostgreSQL', () => {
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
    const identityGuard = await Bun.file(
      resolve(migrationDir, '20260711210000000_session_sandbox_identity_immutability.sql'),
    ).text();

    dockerPsql(`
      ${PRE_MIGRATION_SCHEMA}
      ${identityGuard}

      INSERT INTO kortix.project_sessions(session_id, sandbox_provider) VALUES
        ('managed-session', 'managed'),
        ('platinum-session', 'platinum');
      INSERT INTO kortix.session_sandboxes
        (sandbox_id, session_id, provider, external_id)
      VALUES
        ('00000000-0000-4000-a000-000000000001', 'managed-session', 'managed', 'managed-external'),
        ('00000000-0000-4000-a000-000000000002', 'platinum-session', 'platinum', 'platinum-external');
      INSERT INTO kortix.sandbox_compute_sessions(id, sandbox_id) VALUES
        ('10000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000001'),
        ('10000000-0000-4000-a000-000000000002', '00000000-0000-4000-a000-000000000002'),
        ('10000000-0000-4000-a000-000000000003', '00000000-0000-4000-a000-000000000099');
    `);
  }, 30_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  });

  test('upgrades historical managed rows without weakening runtime identity', async () => {
    const migration = await Bun.file(
      resolve(import.meta.dir, '..', 'migrations', '20260713220000000_e2b_provider_set.sql'),
    ).text();
    dockerPsql(migration);

    const enumValues = dockerPsql(`
      SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
        FROM pg_enum
       WHERE enumtypid = 'kortix.sandbox_provider'::regtype;
    `);
    expect(enumValues.output.trim()).toBe('daytona,platinum,e2b');

    expect(
      dockerPsql(`
        SELECT session_id || ':' || sandbox_provider::text
          FROM kortix.project_sessions ORDER BY session_id;
      `).output.trim(),
    ).toBe('managed-session:daytona\nplatinum-session:platinum');

    expect(
      dockerPsql(`
        SELECT session_id || ':' || provider::text
          FROM kortix.session_sandboxes ORDER BY session_id;
      `).output.trim(),
    ).toBe('managed-session:daytona\nplatinum-session:platinum');

    expect(
      dockerPsql(`
        SELECT id || ':' || provider::text
          FROM kortix.sandbox_compute_sessions ORDER BY id;
      `).output.trim(),
    ).toBe(
      '10000000-0000-4000-a000-000000000001:daytona\n' +
        '10000000-0000-4000-a000-000000000002:platinum\n' +
        '10000000-0000-4000-a000-000000000003:daytona',
    );

    const blocked = dockerPsql(
      `
        \\set VERBOSITY verbose
        UPDATE kortix.session_sandboxes
           SET provider = 'e2b'
         WHERE session_id = 'managed-session';
      `,
      true,
    );
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.output).toContain('23514');
    expect(blocked.output).toContain('established session sandbox identity is immutable');
  });
});
