import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-drop-session-environments-test';
// Below 32768, outside Linux's ephemeral range (see credit-rpc-overloads.test.ts).
const PORT = Number(process.env.DROP_SESSION_ENVIRONMENTS_TEST_PORT || 5452);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

const MIGRATION = '20261007151006000_drop_session_environments';

function psql(sql: string): string {
  const res = sh(['psql', url, '-q', '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${sql}`);
  return res.stdout.trim();
}

const suite = dockerOk ? describe : describe.skip;

suite('drop kortix.session_environments (throwaway Postgres)', () => {
  let refusedCode = -1;
  let tableWhileRefused = '';
  let appliedWhileRefused = '';
  let finalCode = -1;

  beforeAll(async () => {
    sh(['docker', 'rm', '-f', CONTAINER]);
    const up = sh([
      'docker', 'run', '-d', '--name', CONTAINER,
      '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_DB=postgres',
      '--tmpfs', '/var/lib/postgresql/data', '-p', `127.0.0.1:${PORT}:5432`,
      'postgres:16-alpine', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off',
    ]);
    if (!up.ok) throw new Error(`could not start test container: ${up.stderr}`);
    // Host TCP probe, not pg_isready (see worktree-migrate.test.ts).
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = sh(['psql', url, '-tAc', 'select 1']).ok;
      if (!ready) await Bun.sleep(1000);
    }
    if (!ready) throw new Error('test Postgres never became ready');

    // A PL/pgSQL body records no pg_depend row, so a plain DROP would leave
    // this function broken. The migration must refuse instead.
    psql(`create function public.reads_session_environments() returns bigint language plpgsql
          as $f$ begin return (select count(*) from kortix.session_environments); end $f$`);
    refusedCode = await runMigrate(ROOT, ports);
    tableWhileRefused = psql(`select to_regclass('kortix.session_environments') is not null`);
    appliedWhileRefused = psql(
      `select count(*) from kortix_migrations.pgmigrations where name = '${MIGRATION}'`,
    );

    psql('drop function public.reads_session_environments()');
    finalCode = await runMigrate(ROOT, ports);
  }, 300_000);

  afterAll(() => {
    sh(['docker', 'rm', '-f', CONTAINER]);
  });

  test('refuses while a SQL function still reads the table, and keeps the table', () => {
    expect(refusedCode).not.toBe(0);
    expect(tableWhileRefused).toBe('t');
    expect(appliedWhileRefused).toBe('0');
  });

  test('drops the table once nothing references it', () => {
    expect(finalCode).toBe(0);
    expect(psql(`select to_regclass('kortix.session_environments') is null`)).toBe('t');
    expect(
      psql(`select count(*) from kortix_migrations.pgmigrations where name = '${MIGRATION}'`),
    ).toBe('1');
  });
});
