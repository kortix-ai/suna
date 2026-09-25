import { readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import pg from 'pg';

/**
 * `migrate.ts status`: which migrations has this database not applied yet?
 *
 * This module never calls node-pg-migrate's `runner()`. `runner({ dryRun: true })`
 * is NOT read-only in node-pg-migrate 8.0.4:
 *
 *  - it takes the advisory lock, runs `CREATE SCHEMA IF NOT EXISTS` and
 *    `CREATE TABLE` for the ledger;
 *  - it wraps the pending set in `BEGIN` … `COMMIT` (those two statements are
 *    not gated on `dryRun`);
 *  - it calls every pending migration's `up()`. Only the SQL that `up()`
 *    collects through `pgm.sql()` is skipped. A statement that `up()` runs
 *    itself through `pgm.db.query()` (the batched `.concurrent.ts` data passes)
 *    executes and commits.
 *
 * So `status` lists the migration files, reads the ledger inside a read-only
 * transaction on a read-only session, and compares the two. It writes nothing.
 */

export const LEDGER_TABLE = 'kortix_migrations.pgmigrations';

/**
 * node-pg-migrate's timestamp key for a file name (`getNumericPrefix`): a
 * 13-digit prefix is epoch milliseconds, a 17-digit prefix is a UTC
 * `YYYYMMDDHHMMSSmmm` stamp.
 */
function numericPrefix(fileName: string): number {
  const prefix = fileName.split('_')[0] ?? '';
  if (/^\d+$/.test(prefix)) {
    if (prefix.length === 13) return Number(prefix);
    if (prefix.length === 17) {
      return new Date(
        `${prefix.slice(0, 4)}-${prefix.slice(4, 6)}-${prefix.slice(6, 8)}T` +
          `${prefix.slice(8, 10)}:${prefix.slice(10, 12)}:${prefix.slice(12, 14)}.` +
          `${prefix.slice(14, 17)}Z`,
      ).valueOf();
    }
  }
  return Number(prefix) || 0;
}

/** node-pg-migrate's tie-break (`localeCompareStringsNumerically`). */
function compareNumerically(a: string, b: string): number {
  return a.localeCompare(b, undefined, {
    usage: 'sort',
    numeric: true,
    sensitivity: 'variant',
    ignorePunctuation: true,
  });
}

/**
 * Migration names in the order node-pg-migrate applies them. Same file filter
 * (every non-dot file or symlink), same sort, same name (`basename` minus the
 * last extension, so `x.concurrent.ts` is `x.concurrent`).
 */
export function migrationNamesInRunOrder(migrationsDir: string): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => numericPrefix(a) - numericPrefix(b) || compareNumerically(a, b))
    .map((name) => basename(join(migrationsDir, name), extname(name)));
}

export interface MigrationStatusPlan {
  /** Files the ledger does not name, in apply order. */
  pending: string[];
}

/**
 * Pure. `ledgerNames` must be in ledger run order (`ORDER BY run_on, id`).
 * With `checkOrder`, refuse exactly where node-pg-migrate's `up` would refuse,
 * with its message, so `status` never reports "1 pending" for a database the
 * next deploy cannot migrate.
 */
export function planMigrationStatus(
  fileNames: readonly string[],
  ledgerNames: readonly string[],
  { checkOrder }: { checkOrder: boolean },
): MigrationStatusPlan {
  if (checkOrder) {
    const len = Math.min(ledgerNames.length, fileNames.length);
    for (let i = 0; i < len; i += 1) {
      if (ledgerNames[i] !== fileNames[i]) {
        throw new Error(
          `Not run migration ${fileNames[i]} is preceding already run migration ${ledgerNames[i]}`,
        );
      }
    }
  }
  const applied = new Set(ledgerNames);
  return { pending: fileNames.filter((name) => !applied.has(name)) };
}

/** Throws unless a `SHOW` answered `on`. */
export function assertReadOnlySetting(setting: string, value: string | undefined): void {
  if (value !== 'on') {
    throw new Error(
      `migrate status refuses to run: ${setting} is ${JSON.stringify(value ?? null)}, not "on". ` +
        'The status path must read the ledger on a read-only session.',
    );
  }
}

/**
 * A `pg.Client` whose session defaults every transaction to READ ONLY.
 *
 * The setting travels as a startup parameter. `pg` lets an `options=` query
 * parameter in the URL replace it, and a connection pooler can drop it, so the
 * session is checked after connect: when it is not read-only, a session `SET`
 * is tried once; when it is still not read-only, the client is closed and the
 * call throws. Nothing is queried before the check passes.
 */
export async function connectReadOnly(databaseUrl: string): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    options: '-c default_transaction_read_only=on',
  });
  await client.connect();
  try {
    const show = async () =>
      (await client.query<{ default_transaction_read_only: string }>(
        'SHOW default_transaction_read_only',
      )).rows[0]?.default_transaction_read_only;
    let value = await show();
    if (value !== 'on') {
      await client.query('SET default_transaction_read_only = on');
      value = await show();
    }
    assertReadOnlySetting('default_transaction_read_only', value);
    return client;
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}

/**
 * Applied migration names in run order, read inside `BEGIN READ ONLY` … `ROLLBACK`
 * on a `connectReadOnly` session. An absent ledger table reads as empty: it is
 * never created here.
 */
export async function readLedgerReadOnly(databaseUrl: string): Promise<string[]> {
  const client = await connectReadOnly(databaseUrl);
  try {
    await client.query('BEGIN READ ONLY');
    try {
      const txn = await client.query<{ transaction_read_only: string }>('SHOW transaction_read_only');
      assertReadOnlySetting('transaction_read_only', txn.rows[0]?.transaction_read_only);
      const exists = await client.query<{ exists: boolean }>(
        `SELECT to_regclass('${LEDGER_TABLE}') IS NOT NULL AS exists`,
      );
      if (!exists.rows[0]?.exists) return [];
      const ledger = await client.query<{ name: string }>(
        `SELECT name FROM ${LEDGER_TABLE} ORDER BY run_on, id`,
      );
      return ledger.rows.map((row) => row.name);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    await client.end();
  }
}

export async function readMigrationStatus(options: {
  databaseUrl: string;
  migrationsDir: string;
  checkOrder: boolean;
}): Promise<MigrationStatusPlan> {
  const fileNames = migrationNamesInRunOrder(options.migrationsDir);
  const ledgerNames = await readLedgerReadOnly(options.databaseUrl);
  return planMigrationStatus(fileNames, ledgerNames, { checkOrder: options.checkOrder });
}
