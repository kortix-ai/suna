import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';

/**
 * Runtime contract of
 * 20261003055626684_drop_permissions_unused_scope_area_index.concurrent.ts
 * with node-pg-migrate's single-transaction batch runner — proven against the
 * REAL runner with a recording client, no database:
 *
 *   1. the DROP INDEX CONCURRENTLY runs AFTER the batch COMMIT, outside any
 *      transaction (pgm.noTransaction(); CONCURRENTLY cannot run inside one);
 *   2. every statement is a single statement per query — a multi-statement
 *      string re-wraps itself in an implicit transaction and CONCURRENTLY
 *      fails the same way (MIGRATIONS.md "Roll-forward safety");
 *   3. the drop names `kortix.idx_permissions_scope_area`, is `if exists`
 *      (idempotent: a fresh database builds then drops the index), and the
 *      file sets lock_timeout = '180s' — the .concurrent.ts floor the lint
 *      requires;
 *   4. the migration still marks itself applied.
 */

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const MIGRATION_SUFFIX = 'drop_permissions_unused_scope_area_index.concurrent.ts';

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

async function runMigrationInBatch(): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'krtx-1194-migration-'));
  try {
    const file = readdirSync(MIGRATIONS_DIR).find((f) => f.endsWith(MIGRATION_SUFFIX));
    if (!file) throw new Error(`migration file ${MIGRATION_SUFFIX} not found in ${MIGRATIONS_DIR}`);
    copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
    const { client, statements } = recordingClient();
    await runner({
      dbClient: client,
      direction: 'up',
      dir,
      migrationsTable: 'pgmigrations',
      noLock: true,
      singleTransaction: true,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    return statements;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('drop_permissions_unused_scope_area_index migration — node-pg-migrate batch contract', () => {
  test('the drop runs single-statement after COMMIT; lock_timeout is 180s; the index name is exact', async () => {
    const texts = await runMigrationInBatch();

    const batchCommit = texts.findIndex((t) => t.trim() === 'COMMIT;');
    expect(batchCommit).toBeGreaterThan(-1);

    const drops = texts.filter((t) => /drop index concurrently/i.test(t));
    expect(drops).toHaveLength(1);
    const drop = drops[0];
    expect(drop).toContain('kortix.idx_permissions_scope_area');
    expect(/if exists/i.test(drop)).toBe(true);
    // Exactly one statement per query: one trailing semicolon, nothing else.
    expect(drop.split(';').length).toBe(2);
    expect(texts.indexOf(drop)).toBeGreaterThan(batchCommit);

    expect(texts.some((t) => /set lock_timeout = '180s'/i.test(t))).toBe(true);
    expect(texts.some((t) => /set statement_timeout = '30min'/i.test(t))).toBe(true);
  });

  test('the migration marks itself applied', async () => {
    const texts = await runMigrationInBatch();

    expect(
      texts.some(
        (t) =>
          /insert into "public"\."pgmigrations"/i.test(t) &&
          t.includes('drop_permissions_unused_scope_area_index'),
      ),
    ).toBe(true);
  });
});
