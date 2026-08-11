import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasKortixSchema, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';
import { DisposablePostgres, dockerAvailable } from './disposable-postgres';

// Heavy integration test for the worktree's OWN migrate wrapper. The lightweight
// scripts/worktree/__tests__ prove runMigrate references real things (the
// @kortix/db script, psql, test-prereqs.sql); this proves the wrapper actually
// builds the schema end-to-end by running the REAL runMigrate() + hasKortixSchema()
// against a throwaway Postgres — with the postgres:postgres@/postgres creds the
// worktree always uses (a fresh Supabase-local), which the kortix_test container
// in docker-compose.test.yml does not match, so this manages its own container.
//
//   bun test tests/migration/worktree-migrate.test.ts   (needs docker)

const ROOT = repoRoot();
const postgres = new DisposablePostgres('kortix-wt-migrate-test', 'WT_MIGRATE_TEST_PORT');

const suite = dockerAvailable ? describe : describe.skip;

suite('worktree runMigrate (end-to-end against throwaway Postgres)', () => {
  beforeAll(async () => {
    await postgres.start();
  }, 120_000);

  afterAll(() => {
    postgres.stop();
  });

  test('builds the kortix schema from scratch (prereqs + node-pg-migrate)', async () => {
    const code = await runMigrate(ROOT, postgres.ports);
    expect(code).toBe(0);

    expect(hasKortixSchema(postgres.ports)).toBe(true);

    const count = Number(
      sh([
        'psql',
        postgres.url,
        '-tAc',
        "select count(*) from information_schema.tables where table_schema='kortix' and table_type='BASE TABLE'",
      ]).stdout.trim(),
    );
    expect(count).toBeGreaterThanOrEqual(80);
  }, 180_000);

  test('is idempotent — a second run applies nothing and still exits 0', async () => {
    const code = await runMigrate(ROOT, postgres.ports);
    expect(code).toBe(0);
    expect(hasKortixSchema(postgres.ports)).toBe(true);
  }, 120_000);
});

if (!dockerAvailable) {
  // biome-ignore lint/suspicious/noSkippedTests: This integration suite requires a running Docker daemon.
  test.skip('worktree runMigrate integration (docker unavailable — skipped)', () => {});
}
