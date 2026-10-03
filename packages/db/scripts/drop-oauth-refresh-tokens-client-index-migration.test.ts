import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';

/**
 * Runtime contract of 20261003055453938_drop_oauth_refresh_tokens_client_index.concurrent.ts
 * with node-pg-migrate's single-transaction batch runner — proven against the
 * REAL runner with a recording client, no database:
 *
 *   1. `DROP INDEX CONCURRENTLY` runs AFTER the runner's COMMIT of the batch
 *      transaction (CONCURRENTLY cannot run inside any transaction block) and
 *      is a single statement per query — a multi-statement string re-wraps
 *      itself in an implicit transaction and fails the same way
 *      (MIGRATIONS.md "Roll-forward safety");
 *   2. the generous concurrent lock/statement timeouts are set before the
 *      drop (lint floor 120 s);
 *   3. the migration marks itself applied in the ledger.
 */

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const MIGRATION_SUFFIX = 'drop_oauth_refresh_tokens_client_index.concurrent.ts';

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

async function runMigrationInBatch(recording: ReturnType<typeof recordingClient>): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'krtx-1191-migration-'));
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

describe('drop_oauth_refresh_tokens_client_index migration — node-pg-migrate batch contract', () => {
  test('the drop runs single-statement after the batch COMMIT, under the generous timeouts', async () => {
    const texts = await runMigrationInBatch(recordingClient());

    const batchCommit = texts.findIndex((t) => t.trim() === 'COMMIT;');
    expect(batchCommit).toBeGreaterThan(-1);

    const drops = texts.filter((t) => t.includes('drop index concurrently'));
    expect(drops).toHaveLength(1);
    expect(drops[0].toLowerCase()).toContain('kortix.idx_oauth_refresh_tokens_client');
    // Exactly one statement per query: one trailing semicolon, nothing else.
    expect(drops[0].split(';').length).toBe(2);
    expect(texts.indexOf(drops[0])).toBeGreaterThan(batchCommit);

    expect(texts.some((t) => /set lock_timeout = '180s'/i.test(t))).toBe(true);
    expect(texts.some((t) => /set statement_timeout = '30min'/i.test(t))).toBe(true);
    expect(
      texts.some(
        (t) =>
          /insert into/i.test(t) &&
          t.includes('pgmigrations') &&
          t.includes('drop_oauth_refresh_tokens_client_index'),
      ),
    ).toBe(true);
  });
});
