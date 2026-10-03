import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';

/**
 * Runtime contract of 20261003055520493_drop_app_access_grants_app_idx.concurrent.ts
 * with node-pg-migrate's single-transaction batch runner — proven against the
 * REAL runner with a recording client, no database:
 *
 *   1. every statement this migration issues (the timeouts and the
 *      `drop index concurrently`) runs AFTER the runner's batch COMMIT —
 *      CONCURRENTLY cannot run inside any transaction block — and the drop
 *      is a single statement per query (a multi-statement string re-wraps
 *      itself in an implicit transaction and fails the same way;
 *      MIGRATIONS.md "Roll-forward safety");
 *   2. the migration still marks itself applied when the index is already
 *      absent (IF EXISTS makes the drop a server-side no-op).
 */

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const MIGRATION_SUFFIX = 'drop_app_access_grants_app_idx.concurrent.ts';

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

async function runMigrationInBatch(recording: ReturnType<typeof recordingClient>): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'krtx-1181-migration-'));
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

describe('drop_app_access_grants_app_idx migration — node-pg-migrate batch contract', () => {
  test('the concurrent drop runs single-statement after the batch COMMIT, with the generous timeouts', async () => {
    const texts = await runMigrationInBatch(recordingClient());

    const batchCommit = texts.findIndex((t) => t.trim() === 'COMMIT;');
    expect(batchCommit).toBeGreaterThan(-1);

    const drops = texts.filter((t) => t.includes('drop index concurrently'));
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatch(/drop index concurrently if exists kortix\.app_access_grants_app_idx/);
    // Exactly one statement per query: one trailing semicolon, nothing else.
    expect(drops[0].split(';').length).toBe(2);
    expect(texts.indexOf(drops[0])).toBeGreaterThan(batchCommit);
    expect(texts.some((t) => /set lock_timeout = '180s'/i.test(t))).toBe(true);
    expect(texts.some((t) => /set statement_timeout = '30min'/i.test(t))).toBe(true);
  });

  test('the IF EXISTS drop is still issued when the index is absent, and the migration marks itself applied', async () => {
    const texts = await runMigrationInBatch(recordingClient());

    expect(texts.some((t) => /drop index concurrently/i.test(t))).toBe(true);
    expect(
      texts.some(
        (t) =>
          /insert into "public"\."pgmigrations"/i.test(t) &&
          t.includes('drop_app_access_grants_app_idx'),
      ),
    ).toBe(true);
  });
});
