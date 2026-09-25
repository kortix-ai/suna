import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { dockerAvailable } from './docker-available';
import { connectReadOnly } from './catalog';
import { migrationNamesInRunOrder, readMigrationStatus } from './migration-status';

/**
 * `migrate.ts status` must write nothing, including when a pending migration's
 * `up()` writes through `pgm.db.query()`. node-pg-migrate's `dryRun` runs that
 * `up()` and commits its writes; these tests fail against a status built on it.
 */

const container = `kortix-migration-status-${crypto.randomUUID().slice(0, 8)}`;
const scriptsDir = import.meta.dir;
let adminUrl = '';
let migrationsDir = '';

function databaseUrl(name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function query<T extends pg.QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

async function createDatabase(name: string): Promise<string> {
  await query(adminUrl, `create database "${name}"`);
  return databaseUrl(name);
}

const APPLIED = '20260101000000000_create_probe';
const PENDING_WRITER = '20260102000000000_pending_writer.concurrent';
const PENDING_SQL = '20260103000000000_pending_sql';

describe.skipIf(!dockerAvailable)('migrate status is read-only — real PostgreSQL', () => {
  beforeAll(async () => {
    const started = Bun.spawnSync([
      'docker', 'run', '--rm', '-d', '--name', container,
      '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_PASSWORD=test',
      'postgres:16-alpine',
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());
    const port = Bun.spawnSync(['docker', 'port', container, '5432/tcp'], { stdout: 'pipe' })
      .stdout.toString().trim().split(':').at(-1);
    if (!port) throw new Error('Disposable PostgreSQL did not publish a port');
    adminUrl = `postgresql://postgres:test@127.0.0.1:${port}/postgres`;
    for (let attempt = 0; ; attempt += 1) {
      // Over TCP: the image's initdb server listens on the socket only.
      const probe = Bun.spawnSync(
        ['docker', 'exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-c', 'select 1'],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (probe.exitCode === 0) break;
      if (attempt >= 80) throw new Error('Disposable PostgreSQL did not become ready');
      await Bun.sleep(250);
    }

    migrationsDir = mkdtempSync(join(tmpdir(), 'kortix-migration-status-'));
    writeFileSync(
      join(migrationsDir, `${APPLIED}.sql`),
      'CREATE TABLE public.status_probe (id integer NOT NULL);\n',
    );
    // The shape of the batched `.concurrent.ts` data passes: noTransaction()
    // plus statements that up() runs itself.
    writeFileSync(
      join(migrationsDir, `${PENDING_WRITER}.ts`),
      [
        'export const shorthands = undefined;',
        'export const up = async (pgm) => {',
        '  pgm.noTransaction();',
        "  await pgm.db.query('INSERT INTO public.status_probe (id) VALUES (1)');",
        '};',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(migrationsDir, `${PENDING_SQL}.sql`),
      'INSERT INTO public.status_probe (id) VALUES (2);\n',
    );
  }, 60_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
    if (migrationsDir) rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('a pending up() that writes through pgm.db.query is reported pending and does not run', async () => {
    const url = await createDatabase('pending_writer');
    await runner({
      databaseUrl: url,
      dir: migrationsDir,
      migrationsTable: 'pgmigrations',
      migrationsSchema: 'kortix_migrations',
      createMigrationsSchema: true,
      singleTransaction: true,
      direction: 'up',
      count: 1,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });

    const status = await readMigrationStatus({ databaseUrl: url, migrationsDir, checkOrder: true });

    expect(status.pending).toEqual([PENDING_WRITER, PENDING_SQL]);
    expect(await query<{ n: number }>(url, 'select count(*)::int as n from public.status_probe'))
      .toEqual([{ n: 0 }]);
    expect(
      (await query<{ name: string }>(url, 'select name from kortix_migrations.pgmigrations order by id'))
        .map((row) => row.name),
    ).toEqual([APPLIED]);
  });

  test('a database with no ledger reports every file pending and creates no ledger', async () => {
    const url = await createDatabase('no_ledger');

    const status = await readMigrationStatus({ databaseUrl: url, migrationsDir, checkOrder: true });

    expect(status.pending).toEqual([APPLIED, PENDING_WRITER, PENDING_SQL]);
    expect(
      await query<{ schema: string | null }>(url, "select to_regnamespace('kortix_migrations')::text as schema"),
    ).toEqual([{ schema: null }]);
  });

  test('the status session refuses a write even when a caller asks for READ WRITE', async () => {
    const url = await createDatabase('read_only_session');
    const client = await connectReadOnly(url);
    try {
      expect((await client.query('SHOW default_transaction_read_only')).rows[0])
        .toEqual({ default_transaction_read_only: 'on' });
      await expect(client.query('CREATE TABLE public.must_not_exist (id integer)'))
        .rejects.toThrow(/read-only transaction/);
    } finally {
      await client.end();
    }
    expect(await query<{ t: string | null }>(url, "select to_regclass('public.must_not_exist')::text as t"))
      .toEqual([{ t: null }]);
  });

  test('a URL options= parameter that turns read-only off is corrected before any read', async () => {
    const url = new URL(await createDatabase('options_override'));
    url.searchParams.set('options', '-c default_transaction_read_only=off');
    const client = await connectReadOnly(url.toString());
    try {
      expect((await client.query('SHOW default_transaction_read_only')).rows[0])
        .toEqual({ default_transaction_read_only: 'on' });
    } finally {
      await client.end();
    }
  });

  test('the real CLI lists pending migrations on an empty database and writes nothing', async () => {
    const url = await createDatabase('cli_status');
    const expected = migrationNamesInRunOrder(join(scriptsDir, '..', 'migrations'));
    expect(expected.length).toBeGreaterThan(100);

    const proc = Bun.spawnSync(['bun', join(scriptsDir, 'migrate.ts'), 'status'], {
      env: { ...process.env, DATABASE_URL: url },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = proc.stdout.toString();

    expect(proc.stderr.toString()).not.toMatch(/error/i);
    expect(proc.exitCode).toBe(1);
    expect(stdout).toContain(`${expected.length} pending migration(s):`);
    expect(stdout).toContain(`  pending  ${expected[0]}\n`);
    expect(stdout).toContain(`  pending  ${expected.at(-1)}\n`);
    expect(
      await query<{ n: number }>(
        url,
        "select count(*)::int as n from pg_namespace where nspname in ('kortix_migrations', 'kortix')",
      ),
    ).toEqual([{ n: 0 }]);
  }, 60_000);
});
