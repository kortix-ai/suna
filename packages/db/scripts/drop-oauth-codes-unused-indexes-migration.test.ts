import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';

/**
 * Runtime contract of 20261003091224043_drop_unused_oauth_codes_indexes.concurrent.ts
 * with node-pg-migrate's single-transaction batch runner — proven against the
 * REAL runner with a recording client, no database:
 *
 *   1. every `drop index concurrently if exists` runs AFTER the runner's
 *      COMMIT (CONCURRENTLY cannot run inside any transaction block) and is a
 *      single statement per query — a multi-statement string re-wraps itself
 *      in an implicit transaction and fails the same way (MIGRATIONS.md
 *      "Roll-forward safety");
 *   2. the lock_timeout/statement_timeout budgets are set BEFORE the drops
 *      queue, so a 55P03 on the lock wait cancels the drop, not the budget;
 *   3. the migration still marks itself applied in the ledger.
 */

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const MIGRATION_SUFFIX = 'drop_unused_oauth_codes_indexes.concurrent.ts';

/** Records every statement the runner executes; answers nothing. */
function recordingClient() {
  const statements: string[] = [];
  const client = {
    query(text: unknown) {
      const sql = typeof text === 'string' ? text : String((text as { text?: string })?.text ?? '');
      statements.push(sql);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  return { client, statements };
}

async function runMigrationInBatch(
  recording: ReturnType<typeof recordingClient>,
): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'krtx-1188-migration-'));
  try {
    const file = readdirSync(MIGRATIONS_DIR).find((f) => f.endsWith(MIGRATION_SUFFIX));
    if (!file) throw new Error(`migration file ${MIGRATION_SUFFIX} not found in ${MIGRATIONS_DIR}`);
    copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
    await runner({
      dbClient: recording.client,
      direction: 'up',
      dir,
      migrationsTable: 'pgmigrations',
      noLock: true,
      singleTransaction: true,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    return recording.statements;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('drop_unused_oauth_codes_indexes migration — node-pg-migrate batch contract', () => {
  test('both drops run single-statement after COMMIT, with the lock budget set before them', async () => {
    const texts = await runMigrationInBatch(recordingClient());

    const batchCommit = texts.findIndex((t) => t.trim() === 'COMMIT;');
    expect(batchCommit).toBeGreaterThan(-1);

    const drops = texts.filter((t) => t.includes('drop index concurrently'));
    expect(drops).toHaveLength(2);
    expect(drops.some((t) => /idx_oauth_codes_client/.test(t))).toBe(true);
    expect(drops.some((t) => /idx_oauth_codes_expires/.test(t))).toBe(true);
    for (const drop of drops) {
      // Exactly one statement per query: one trailing semicolon, nothing else.
      expect(drop.split(';').length).toBe(2);
      expect(texts.indexOf(drop)).toBeGreaterThan(batchCommit);
    }

    const lockTimeout = texts.findIndex((t) => /set lock_timeout = '180s'/i.test(t));
    const statementTimeout = texts.findIndex((t) => /set statement_timeout = '30min'/i.test(t));
    expect(lockTimeout).toBeGreaterThan(-1);
    expect(statementTimeout).toBeGreaterThan(-1);
    expect(lockTimeout).toBeGreaterThan(batchCommit);
    expect(lockTimeout).toBeLessThan(texts.indexOf(drops[0]));
    expect(statementTimeout).toBeLessThan(texts.indexOf(drops[0]));
  });

  test('the migration marks itself applied in the ledger', async () => {
    const texts = await runMigrationInBatch(recordingClient());

    expect(
      texts.some(
        (t) =>
          /insert into "public"\."pgmigrations"/i.test(t) &&
          t.includes('drop_unused_oauth_codes_indexes'),
      ),
    ).toBe(true);
  });
});
