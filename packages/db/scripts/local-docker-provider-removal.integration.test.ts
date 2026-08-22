import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { materializeMigrationRuntimeDirectory } from './migration-runtime-overrides';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;

const container = `kortix-retired-provider-migration-${crypto.randomUUID().slice(0, 8)}`;

function psql(sql: string, allowFailure = false) {
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
  DROP SCHEMA IF EXISTS kortix CASCADE;
  CREATE SCHEMA kortix;
  CREATE TYPE kortix.sandbox_provider AS ENUM
    ('daytona', 'platinum', 'e2b', 'local-docker');

  CREATE TABLE kortix.project_sessions (
    session_id text PRIMARY KEY,
    sandbox_provider kortix.sandbox_provider NOT NULL DEFAULT 'daytona'
  );
  CREATE VIEW kortix.workspace_sessions AS
    SELECT session_id, sandbox_provider FROM kortix.project_sessions;
  CREATE TABLE kortix.session_sandboxes (
    sandbox_id uuid PRIMARY KEY,
    external_id text,
    provider kortix.sandbox_provider NOT NULL DEFAULT 'daytona'
  );
  CREATE FUNCTION kortix.guard_session_sandbox_identity()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END $$;
  CREATE TRIGGER trg_session_sandbox_identity_immutable
  BEFORE UPDATE OF external_id, provider OR DELETE
  ON kortix.session_sandboxes
  FOR EACH ROW
  EXECUTE FUNCTION kortix.guard_session_sandbox_identity();
  CREATE TABLE kortix.provider_transitions (
    transition_id uuid PRIMARY KEY,
    source_provider kortix.sandbox_provider NOT NULL,
    target_provider kortix.sandbox_provider NOT NULL
  );
  CREATE TABLE kortix.sandbox_compute_sessions (
    id uuid PRIMARY KEY,
    provider kortix.sandbox_provider NOT NULL DEFAULT 'daytona'
  );
  CREATE TABLE kortix.app_deployments (
    deployment_id uuid PRIMARY KEY,
    hosting_provider varchar(32)
  );
  CREATE TABLE kortix.app_runtimes (
    runtime_id uuid PRIMARY KEY,
    provider varchar(32) NOT NULL
  );
`;

describe.skipIf(!dockerAvailable)('retired local provider migration — real PostgreSQL', () => {
let migration = '';
let cleanupRuntimeMigrations = () => {};

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
    for (let attempt = 0; attempt < 40; attempt += 1) {
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

    const runtime = materializeMigrationRuntimeDirectory(resolve(import.meta.dir, '..', 'migrations'));
    cleanupRuntimeMigrations = runtime.cleanup;
    migration = await Bun.file(
      resolve(runtime.path, '20260807165721291_remove_local_docker_provider.sql'),
    ).text();
  }, 30_000);

  beforeEach(() => {
    psql(PRE_MIGRATION_SCHEMA);
  });

  afterAll(() => {
    cleanupRuntimeMigrations();
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  });

  test('removes the enum value when every affected table is empty', () => {
    psql(migration);

    expect(
      psql(`
        SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
          FROM pg_enum
         WHERE enumtypid = 'kortix.sandbox_provider'::regtype;
      `).output.trim(),
    ).toBe('daytona,platinum,e2b');

    expect(
      psql(`
        SELECT table_name || ':' || column_name || ':' || column_default
          FROM information_schema.columns
         WHERE table_schema = 'kortix'
           AND (table_name, column_name) IN (
             ('project_sessions', 'sandbox_provider'),
             ('session_sandboxes', 'provider'),
             ('sandbox_compute_sessions', 'provider')
           )
         ORDER BY table_name;
      `).output.trim(),
    ).toBe(
      "project_sessions:sandbox_provider:'daytona'::kortix.sandbox_provider\n" +
        "sandbox_compute_sessions:provider:'daytona'::kortix.sandbox_provider\n" +
        "session_sandboxes:provider:'daytona'::kortix.sandbox_provider",
    );

    expect(
      psql(`
        SELECT count(*)
          FROM pg_trigger
         WHERE tgrelid = 'kortix.session_sandboxes'::regclass
           AND tgname = 'trg_session_sandbox_identity_immutable'
           AND NOT tgisinternal;
      `).output.trim(),
    ).toBe('1');

    expect(psql(`SELECT to_regclass('kortix.workspace_sessions');`).output.trim()).toBe('');
  });

  test('fails closed and names every table that still contains retired rows', () => {
    psql(`
      INSERT INTO kortix.project_sessions VALUES ('session-1', 'local-docker');
      INSERT INTO kortix.session_sandboxes VALUES
        ('00000000-0000-4000-a000-000000000001', NULL, 'local-docker');
      INSERT INTO kortix.provider_transitions VALUES
        ('10000000-0000-4000-a000-000000000001', 'local-docker', 'daytona');
      INSERT INTO kortix.sandbox_compute_sessions VALUES
        ('20000000-0000-4000-a000-000000000001', 'local-docker');
      INSERT INTO kortix.app_deployments VALUES
        ('30000000-0000-4000-a000-000000000001', 'local-docker');
      INSERT INTO kortix.app_runtimes VALUES
        ('40000000-0000-4000-a000-000000000001', 'local-docker');
    `);

    const result = psql(migration, true);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      'retired sandbox provider still has rows in: project_sessions, session_sandboxes, ' +
        'provider_transitions, sandbox_compute_sessions, app_deployments, app_runtimes; ' +
        'archive or delete them before upgrading',
    );
  });
});
