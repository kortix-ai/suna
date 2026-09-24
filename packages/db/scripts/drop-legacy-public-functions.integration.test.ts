/**
 * The legacy `public` function drop, against a real PostgreSQL.
 *
 * The migration drops functions that only databases older than the Kortix
 * baseline still carry. Two things are worth a test: it drops exactly its list
 * and nothing that shares a name, and it refuses (dropping nothing) while a
 * surviving function body or a pg_cron command still calls a listed function.
 * Neither kind of caller records a pg_depend row, so a plain DROP FUNCTION
 * would succeed and leave the caller broken.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { dockerAvailable } from './docker-available';

const container = `kortix-drop-legacy-fns-${crypto.randomUUID().slice(0, 8)}`;
const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_drop_legacy_public_functions.sql').scanSync({ cwd: migrationDirectory }),
);
let containerStarted = false;
let migration = '';
let listed: string[] = [];

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

/** The signatures the migration lists, read from the migration itself. */
function listedSignatures(sql: string): string[] {
  return Array.from(sql.matchAll(/'(public\.[a-z_]+\([^)]*\))'/g), (match) => match[1]!);
}

/** A stub for every listed signature, the legacy functions the migration must
 *  keep, their callers, and the two pg_cron jobs a legacy database runs. */
function legacyFixture(): string {
  const stubs = listed
    .map((signature) => `CREATE FUNCTION ${signature} RETURNS void LANGUAGE sql AS '';`)
    .join('\n');
  return `
    CREATE SCHEMA basejump;
    CREATE SCHEMA cron;
    CREATE TABLE cron.job (jobid serial PRIMARY KEY, jobname text, command text);
    ${stubs}
    -- kept: other overloads of dropped names
    CREATE FUNCTION public.add_credits(uuid, numeric, uuid) RETURNS void LANGUAGE sql AS '';
    CREATE FUNCTION public.grant_tier_credits(uuid, text, numeric) RETURNS void LANGUAGE sql AS '';
    -- kept: still called by a live pg_cron job and a trigger function
    CREATE FUNCTION public.delete_user_data(uuid, uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
    CREATE FUNCTION public.get_user_email(uuid) RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
    CREATE FUNCTION public.process_scheduled_account_deletions() RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM delete_user_data(NULL, NULL);
    END $$;
    CREATE FUNCTION public.process_monthly_refills() RETURNS void LANGUAGE sql AS '';
    CREATE FUNCTION basejump.ensure_billing_customer_email() RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM public.get_user_email(NULL);
    END $$;
    INSERT INTO cron.job (jobname, command) VALUES
      ('yearly-plan-monthly-refill', 'SELECT process_monthly_refills();'),
      ('process-scheduled-account-deletions', 'SELECT process_scheduled_account_deletions();');
  `;
}

function freshDatabase(name: string, fixture: string) {
  dockerPsql('postgres', `CREATE DATABASE ${name};`);
  if (fixture) dockerPsql(name, fixture);
}

function listedRemaining(database: string): number {
  const values = listed.map((signature) => `('${signature}')`).join(', ');
  return Number(
    dockerPsql(
      database,
      `SELECT count(*) FROM (VALUES ${values}) v(sig) WHERE to_regprocedure(v.sig) IS NOT NULL;`,
    ),
  );
}

function keptPresent(database: string): string {
  return dockerPsql(
    database,
    `SELECT string_agg(sig || '=' || (to_regprocedure(sig) IS NOT NULL), ',' ORDER BY sig)
       FROM unnest(ARRAY[
         'public.add_credits(uuid, numeric, uuid)',
         'public.delete_user_data(uuid, uuid)',
         'public.get_user_email(uuid)',
         'public.grant_tier_credits(uuid, text, numeric)',
         'public.process_scheduled_account_deletions()'
       ]) AS sig;`,
  );
}

describe.skipIf(!dockerAvailable)('drop legacy public functions migration — real PostgreSQL', () => {
  beforeAll(async () => {
    if (migrationNames.length !== 1) return;
    migration = await Bun.file(resolve(migrationDirectory, migrationNames[0]!)).text();
    listed = listedSignatures(migration);

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

  test('lists 57 distinct signatures, none of them a function it must keep', () => {
    expect(migrationNames).toHaveLength(1);
    expect(listed).toHaveLength(57);
    expect(new Set(listed).size).toBe(57);
    for (const kept of [
      'public.delete_user_data(',
      'public.get_user_email(',
      'public.add_credits(uuid, numeric, uuid)',
      'public.grant_tier_credits(uuid, text, numeric)',
    ]) {
      expect(listed.some((signature) => signature.startsWith(kept))).toBe(false);
    }
  });

  test('drops every listed signature, keeps the rest, and a second apply is a no-op', () => {
    freshDatabase('legacy_db', legacyFixture());
    expect(listedRemaining('legacy_db')).toBe(57);

    applyMigration('legacy_db');
    expect(listedRemaining('legacy_db')).toBe(0);
    const allKept =
      'public.add_credits(uuid, numeric, uuid)=true,public.delete_user_data(uuid, uuid)=true,' +
      'public.get_user_email(uuid)=true,public.grant_tier_credits(uuid, text, numeric)=true,' +
      'public.process_scheduled_account_deletions()=true';
    expect(keptPresent('legacy_db')).toBe(allKept);

    applyMigration('legacy_db');
    expect(keptPresent('legacy_db')).toBe(allKept);
  }, 60_000);

  test('is a no-op on a database built from the Kortix baseline', () => {
    freshDatabase('baseline_db', '');
    applyMigration('baseline_db');
    expect(listedRemaining('baseline_db')).toBe(0);
  }, 60_000);

  test('refuses and drops nothing while a surviving function calls a listed one', () => {
    freshDatabase(
      'body_caller_db',
      `${legacyFixture()}
       CREATE FUNCTION public.still_calls_legacy() RETURNS void LANGUAGE plpgsql AS $$
       BEGIN
         PERFORM public.get_retention_data(1, 1, 1, 1);
       END $$;`,
    );
    expect(() => applyMigration('body_caller_db')).toThrow(
      /still referenced: public\.still_calls_legacy calls get_retention_data/,
    );
    expect(listedRemaining('body_caller_db')).toBe(57);
  }, 60_000);

  test('refuses and drops nothing while a pg_cron command calls a listed one', () => {
    freshDatabase(
      'cron_caller_db',
      `${legacyFixture()}
       INSERT INTO cron.job (jobname, command) VALUES ('legacy-job', 'SELECT unschedule_job_by_name(''x'')');`,
    );
    expect(() => applyMigration('cron_caller_db')).toThrow(
      /still referenced: pg_cron job legacy-job calls unschedule_job_by_name/,
    );
    expect(listedRemaining('cron_caller_db')).toBe(57);
  }, 60_000);
});
