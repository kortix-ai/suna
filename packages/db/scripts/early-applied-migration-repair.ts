import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Idempotent CONCURRENTLY migrations that a targeted release applied before
 * older-named migrations reached the same database.
 *
 * node-pg-migrate `checkOrder` then refuses every later `up` ("Not run
 * migration X is preceding already run migration Y"). Each listed migration is
 * `create index concurrently if not exists`, so releasing its ledger row lets
 * the runner apply the older migrations and re-run this one in file order as
 * a no-op.
 *
 * 20260916150159063_session_list_keyset_index: shipped alone to staging and
 * prod in v0.13.20 (#7314), ahead of seven migrations dated 2026-09-14..16.
 */
export const EARLY_APPLIED_MIGRATIONS = [
  {
    name: '20260916150159063_session_list_keyset_index.concurrent',
    filename: '20260916150159063_session_list_keyset_index.concurrent.ts',
    sha256: '187586b810b388041c2820e63243ff86917917fe265f5dbbd2f25a7f69cd840a',
  },
] as const;

export function migrationNamesInDirectory(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((filename) => filename.endsWith('.sql') || filename.endsWith('.ts'))
    .filter((filename) => !filename.endsWith('.test.ts'))
    .map((filename) => filename.replace(/\.(sql|ts)$/, ''))
    .sort();
}

export function planEarlyAppliedMigrationRepair(
  ledgerNames: string[],
  fileNames: string[],
): string[] {
  const applied = new Set(ledgerNames);
  return EARLY_APPLIED_MIGRATIONS.filter(({ name }) => applied.has(name))
    .filter(({ name }) => fileNames.some((file) => file < name && !applied.has(file)))
    .map(({ name }) => name);
}

export async function repairEarlyAppliedMigrations(
  databaseUrl: string,
  migrationsDir: string,
): Promise<string[]> {
  const fileNames = migrationNamesInDirectory(migrationsDir);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const table = await client.query<{ exists: boolean }>(
      "select to_regclass('kortix_migrations.pgmigrations') is not null as exists",
    );
    if (!table.rows[0]?.exists) return [];

    await client.query('begin');
    try {
      await client.query('lock table kortix_migrations.pgmigrations in exclusive mode');
      const ledger = await client.query<{ name: string }>(
        'select name from kortix_migrations.pgmigrations',
      );
      const release = planEarlyAppliedMigrationRepair(
        ledger.rows.map((row) => row.name),
        fileNames,
      );
      for (const name of release) {
        const migration = EARLY_APPLIED_MIGRATIONS.find((entry) => entry.name === name);
        const path = join(migrationsDir, migration?.filename ?? '');
        const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
        if (actual !== migration?.sha256) {
          throw new Error(`Early-applied migration repair checksum mismatch for ${name}: ${actual}.`);
        }
        await client.query('delete from kortix_migrations.pgmigrations where name = $1', [name]);
      }
      await client.query('commit');
      return release;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  } finally {
    await client.end();
  }
}
