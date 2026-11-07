import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { ledgerExists } from '../src/ledger-exists';
import { withClient, withTransaction } from '../src/with-client';

export const LEDGER_TABLE = 'kortix_migrations.pgmigrations';

/** Throws unless the migration file in `migrationsDir` hashes to the pinned sha256. */
export function verifyMigrationChecksum(
  migrationsDir: string,
  { filename, sha256 }: { filename: string; sha256: string },
): void {
  const actual = createHash('sha256').update(readFileSync(join(migrationsDir, filename))).digest('hex');
  if (actual !== sha256) {
    throw new Error(`Migration checksum mismatch for ${filename}: expected ${sha256}, received ${actual}.`);
  }
}

/**
 * Runs `fn` in one transaction that holds an exclusive lock on the migration
 * ledger. Returns `whenMissing` without opening a transaction when the ledger
 * table does not exist yet.
 */
export function withLedgerLock<T>(
  databaseUrl: string,
  whenMissing: T,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withClient(databaseUrl, async (client) => {
    if (!(await ledgerExists(client))) return whenMissing;

    return withTransaction(client, async () => {
      await client.query(`lock table ${LEDGER_TABLE} in exclusive mode`);
      return fn(client);
    });
  });
}
