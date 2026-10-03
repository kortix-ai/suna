/**
 * The scheduled-account-deletion cron retirement, against a real PostgreSQL.
 *
 * The migration unschedules the legacy pg_cron job
 * `process-scheduled-account-deletions` and drops the two legacy `public`
 * functions it calls (the wrapper and its `delete_user_data` cascade) — the
 * processor whose unqualified table reference made it sweep the pre-baseline
 * legacy copy instead of `kortix.account_deletion_requests` since the schema
 * moved (KRTX-1260). Worth a test: it unschedules exactly that job and keeps
 * every other one, and it refuses — changing nothing — while any OTHER
 * pg_cron command or surviving function body still calls a dropped function.
 * Neither kind of caller records a pg_depend row, so a plain DROP FUNCTION
 * would succeed and leave the caller broken.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { dockerAvailable } from './docker-available';

const container = `kortix-retire-deletion-cron-${crypto.randomUUID().slice(0, 8)}`;
const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_retire_scheduled_account_deletions_cron.sql').scanSync({ cwd: migrationDirectory }),
);
let containerStarted = false;
let migration = '';

function dockerPsql(database: string, sql: string) {
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
      database,
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

/** node-pg-migrate runs each file in one transaction; mirror that. */
function applyMigration(database: string) {
  return dockerPsql(database, `BEGIN;\n${migration}\nCOMMIT;\n`);
}

/**
 * The legacy surface the retired processor lives on: the two functions, the
 * daily job that calls the wrapper, and an unrelated job that must survive.
 */
function legacyFixture(): string {
  return `
    CREATE SCHEMA cron;
    CREATE TABLE cron.job (jobid serial PRIMARY KEY, jobname text, command text);
    -- Real pg_cron's text-overload semantics, so the migration's
    -- cron.unschedule call works on the fixture: delete the row, return true.
    CREATE FUNCTION cron.unschedule(p_jobname text) RETURNS boolean LANGUAGE sql AS $unsched$
      DELETE FROM cron.job WHERE jobname = p_jobname;
      SELECT true;
    $unsched$;
    CREATE FUNCTION public.delete_user_data(uuid, uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
    CREATE FUNCTION public.process_scheduled_account_deletions() RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM delete_user_data(NULL, NULL);
    END $$;
    CREATE FUNCTION public.unrelated_survivor() RETURNS void LANGUAGE sql AS '';
    INSERT INTO cron.job (jobname, command) VALUES
      ('yearly-plan-monthly-refill', 'SELECT unrelated_survivor();'),
      ('process-scheduled-account-deletions', 'SELECT process_scheduled_account_deletions();');
  `;
}

function freshDatabase(name: string, fixture: string) {
  dockerPsql('postgres', `CREATE DATABASE ${name};`);
  if (fixture) dockerPsql(name, fixture);
}

/** `job=<count>` for the retired job, then the survivor, then both functions.
 *
 * The cron counts are read only when a `cron` schema exists at all: a fresh
 * baseline database has none, and a statement that names `cron.job` fails to
 * plan there even inside `CASE`/`COALESCE`.
 */
function state(database: string): string {
  const hasCron = dockerPsql(database, "SELECT to_regclass('cron.job') IS NOT NULL;") === 't';
  const jobs = hasCron
    ? dockerPsql(
        database,
        `SELECT format('retired_job=%s,survivor_job=%s',
           (SELECT count(*) FROM cron.job WHERE jobname = 'process-scheduled-account-deletions'),
           (SELECT count(*) FROM cron.job WHERE jobname = 'yearly-plan-monthly-refill'));`,
      )
    : 'retired_job=0,survivor_job=0';
  return (
    jobs +
    dockerPsql(
      database,
      `SELECT format(',wrapper=%s,cascade=%s',
         (to_regprocedure('public.process_scheduled_account_deletions()') IS NOT NULL),
         (to_regprocedure('public.delete_user_data(uuid, uuid)') IS NOT NULL));`,
    )
  );
}

describe.skipIf(!dockerAvailable)('retire scheduled-account-deletions cron migration — real PostgreSQL', () => {
  beforeAll(async () => {
    if (migrationNames.length !== 1) return;
    migration = await Bun.file(resolve(migrationDirectory, migrationNames[0]!)).text();

    const started = Bun.spawnSync([
      'docker',
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-e',
      'POSTGRES_PASSWORD=test',
      'postgres:16-alpine',
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());
    containerStarted = true;

    for (let attempt = 0; attempt < 50; attempt += 1) {
      // TCP, never the unix socket: initdb runs a temporary socket-only
      // server whose readiness says nothing about the real one.
      const probe = Bun.spawnSync(
        ['docker', 'exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-c', 'SELECT 1'],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (probe.exitCode === 0) return;
      await Bun.sleep(250);
    }
    throw new Error('Disposable PostgreSQL did not become ready');
  }, 60_000);

  afterAll(() => {
    if (!containerStarted) return;
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  });

  test('unschedules the retired job, drops both functions, keeps everything else', () => {
    expect(migrationNames).toHaveLength(1);
    freshDatabase('legacy_db', legacyFixture());
    expect(state('legacy_db')).toBe('retired_job=1,survivor_job=1,wrapper=true,cascade=true');

    applyMigration('legacy_db');
    expect(state('legacy_db')).toBe('retired_job=0,survivor_job=1,wrapper=false,cascade=false');
  }, 60_000);

  test('is a no-op on a database without the legacy job or functions', () => {
    freshDatabase('baseline_db', '');
    applyMigration('baseline_db');
    expect(state('baseline_db')).toBe('retired_job=0,survivor_job=0,wrapper=false,cascade=false');
  }, 60_000);

  test('refuses and changes nothing while another pg_cron job calls a dropped function', () => {
    freshDatabase(
      'cron_caller_db',
      `${legacyFixture()}
       INSERT INTO cron.job (jobname, command) VALUES ('legacy-job', 'SELECT delete_user_data(''x'', NULL)');`,
    );
    expect(() => applyMigration('cron_caller_db')).toThrow(
      /retire refused, still referenced: pg_cron job legacy-job calls delete_user_data/,
    );
    expect(state('cron_caller_db')).toBe('retired_job=1,survivor_job=1,wrapper=true,cascade=true');
  }, 60_000);

  test('refuses and changes nothing while a surviving function body calls the cascade', () => {
    freshDatabase(
      'body_caller_db',
      `${legacyFixture()}
       CREATE FUNCTION public.still_cascades() RETURNS void LANGUAGE plpgsql AS $$
       BEGIN
         PERFORM public.delete_user_data(NULL, NULL);
       END $$;`,
    );
    expect(() => applyMigration('body_caller_db')).toThrow(
      /retire refused, still referenced: public\.still_cascades calls delete_user_data/,
    );
    expect(state('body_caller_db')).toBe('retired_job=1,survivor_job=1,wrapper=true,cascade=true');
  }, 60_000);
});
