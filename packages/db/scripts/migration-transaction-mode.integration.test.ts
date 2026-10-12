import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { dockerAvailable } from './docker-available';
import { RUNNER_TRANSACTION_MODE } from './migration-target';

/**
 * `migrate.ts up` commits each migration file on its own. A backlog in one
 * transaction held every table's locks to the end and deadlocked against live
 * prod traffic (2026-10-11). Here the second of two pending files fails: the
 * first stays applied and recorded, so locks never span files.
 */

const container = `kortix-migration-txmode-${crypto.randomUUID().slice(0, 8)}`;
let url = '';
let migrationsDir = '';

async function query<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

describe.skipIf(!dockerAvailable)('migrate up: one transaction per file — real PostgreSQL', () => {
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
    url = `postgresql://postgres:test@127.0.0.1:${port}/postgres`;
    for (let attempt = 0; ; attempt += 1) {
      const probe = Bun.spawnSync(
        ['docker', 'exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-c', 'select 1'],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (probe.exitCode === 0) break;
      if (attempt >= 80) throw new Error('Disposable PostgreSQL did not become ready');
      await Bun.sleep(250);
    }
    migrationsDir = mkdtempSync(join(tmpdir(), 'kortix-migration-txmode-'));
    writeFileSync(join(migrationsDir, '20260101000000000_first.sql'), 'CREATE TABLE public.txmode_first (id integer);\n');
    writeFileSync(join(migrationsDir, '20260102000000000_second_fails.sql'), 'SELECT 1 / 0;\n');
  }, 60_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', '-v', container], { stdout: 'ignore', stderr: 'ignore' });
    if (migrationsDir) rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('a failing file rolls back only itself; the file before it stays applied', async () => {
    await expect(
      runner({
        databaseUrl: url,
        dir: migrationsDir,
        migrationsTable: 'pgmigrations',
        migrationsSchema: 'kortix_migrations',
        createMigrationsSchema: true,
        ...RUNNER_TRANSACTION_MODE,
        direction: 'up',
        count: Number.POSITIVE_INFINITY,
        log: () => {},
      }),
    ).rejects.toThrow();

    const applied = await query<{ name: string }>('select name from kortix_migrations.pgmigrations order by id');
    expect(applied.map((row) => row.name)).toEqual(['20260101000000000_first']);
    const table = await query<{ t: string | null }>("select to_regclass('public.txmode_first')::text as t");
    expect(table[0]?.t).toBe('txmode_first');
  });
});
