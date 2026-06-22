import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type Ports,
  computePorts,
  hasKortixSchema,
  repoRoot,
  runMigrate,
  sh,
} from '../../scripts/worktree/lib';

// Heavy integration test for the worktree's OWN migrate wrapper. The lightweight
// scripts/worktree/__tests__ prove runMigrate references real things (the
// @kortix/db script, psql, test-prereqs.sql); this proves the wrapper actually
// builds the schema end-to-end by running the REAL runMigrate() + hasKortixSchema()
// against a throwaway Postgres — with the postgres:postgres@/postgres creds the
// worktree always uses (a fresh Supabase-local), which the kortix_test container
// in docker-compose.test.yml does not match, so this manages its own container.
//
//   bun test tests/migration/worktree-migrate.test.ts   (needs docker)

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-wt-migrate-test';
const PORT = Number(process.env.WT_MIGRATE_TEST_PORT || 55440);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };

function pgReady(): boolean {
  return sh(['docker', 'exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres']).ok;
}

const suite = dockerOk ? describe : describe.skip;

suite('worktree runMigrate (end-to-end against throwaway Postgres)', () => {
  beforeAll(async () => {
    sh(['docker', 'rm', '-f', CONTAINER]);
    const up = sh([
      'docker', 'run', '-d', '--name', CONTAINER,
      '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_USER=postgres',
      '-e', 'POSTGRES_DB=postgres',
      '--tmpfs', '/var/lib/postgresql/data',
      '-p', `127.0.0.1:${PORT}:5432`,
      'postgres:16-alpine',
      '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off',
    ]);
    if (!up.ok) throw new Error(`could not start test container: ${up.stderr}`);
    for (let i = 0; i < 60; i++) {
      if (pgReady()) return;
      await Bun.sleep(1000);
    }
    throw new Error('test Postgres never became ready');
  }, 120_000);

  afterAll(() => {
    sh(['docker', 'rm', '-f', CONTAINER]);
  });

  test(
    'builds the kortix schema from scratch (prereqs + node-pg-migrate)',
    async () => {
      const code = await runMigrate(ROOT, ports);
      expect(code).toBe(0);

      expect(hasKortixSchema(ports)).toBe(true);

      const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
      const count = Number(
        sh(['psql', url, '-tAc',
          "select count(*) from information_schema.tables where table_schema='kortix' and table_type='BASE TABLE'",
        ]).stdout.trim(),
      );
      expect(count).toBeGreaterThanOrEqual(80);
    },
    180_000,
  );

  test('is idempotent — a second run applies nothing and still exits 0', async () => {
    const code = await runMigrate(ROOT, ports);
    expect(code).toBe(0);
    expect(hasKortixSchema(ports)).toBe(true);
  }, 120_000);
});

if (!dockerOk) {
  test.skip('worktree runMigrate integration (docker unavailable — skipped)', () => {});
}
