import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';

/**
 * Runtime contract of 20261003055112086_drop_integrations_unused_indexes.concurrent.ts
 * with node-pg-migrate's single-transaction batch runner — proven against the
 * REAL runner with a recording client, no database:
 *
 *   1. both `drop index concurrently if exists` statements run AFTER the
 *      runner commits the batch transaction (CONCURRENTLY cannot run inside
 *      any transaction block) and are a single statement per query — a
 *      multi-statement string re-wraps itself in an implicit transaction and
 *      fails the same way (MIGRATIONS.md "Roll-forward safety");
 *   2. the lock_timeout budget is set before the drops queue, so a live
 *      system's long-running transactions cannot outlive it and strand an
 *      INVALID index (55P03 class, learnings 2026-08-19);
 *   3. the migration has no catalog probe and no guard: both statements are
 *      `if exists`, so on a database without the legacy table (the Kortix
 *      baseline never creates kortix.integrations) they still execute as
 *      server-side no-ops and the migration still marks itself applied.
 */

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const MIGRATION_SUFFIX = 'drop_integrations_unused_indexes.concurrent.ts';

/** Records every statement the runner executes. */
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
  const dir = mkdtempSync(join(tmpdir(), 'krtx-1185-migration-'));
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

describe('drop_integrations_unused_indexes migration — node-pg-migrate batch contract', () => {
  test('lock_timeout precedes both single-statement drops, and both run after COMMIT', async () => {
    const texts = await runMigrationInBatch(recordingClient());

    // pgm.noTransaction(): the runner COMMITs the outer batch transaction
    // before this migration's queued statements run.
    const batchCommit = texts.findIndex((t) => t.trim() === 'COMMIT;');
    expect(batchCommit).toBeGreaterThan(-1);

    const lockTimeout = texts.findIndex((t) => /set lock_timeout = '180s'/i.test(t));
    expect(lockTimeout).toBeGreaterThan(-1);

    const drops = texts.filter((t) => t.includes('drop index concurrently'));
    expect(drops).toHaveLength(2);
    expect(drops.some((t) => /kortix\.idx_integrations_account\b/i.test(t))).toBe(true);
    expect(drops.some((t) => /kortix\.idx_integrations_provider_account\b/i.test(t))).toBe(true);
    for (const drop of drops) {
      // Exactly one statement per query: one trailing semicolon, nothing else.
      expect(drop.split(';').length).toBe(2);
      // lock_timeout is in force when the drop queues (55P03 guard).
      expect(texts.indexOf(drop)).toBeGreaterThan(lockTimeout);
      // CONCURRENTLY runs after the batch transaction is committed.
      expect(texts.indexOf(drop)).toBeGreaterThan(batchCommit);
    }
  });

  test('the migration still marks itself applied on a database without the legacy table', async () => {
    const texts = await runMigrationInBatch(recordingClient());

    expect(
      texts.some(
        (t) =>
          /insert into "public"\."pgmigrations"/i.test(t) &&
          t.includes('drop_integrations_unused_indexes'),
      ),
    ).toBe(true);
  });
});
