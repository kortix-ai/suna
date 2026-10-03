import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';

/**
 * Runtime contract of 20261003055531313_drop_projects_updated_index.concurrent.ts
 * with node-pg-migrate's single-transaction batch runner — proven against the
 * REAL runner with a recording client, no database:
 *
 *   1. the batch transaction is broken before the statements run:
 *      `pgm.noTransaction()` unshifts `COMMIT;` ahead of the buffered steps, so
 *      `drop index concurrently` cannot end up inside it (CONCURRENTLY fails
 *      with "cannot run inside a transaction block" there — the 2026-07-16
 *      incident class MIGRATIONS.md "Roll-forward safety" guards against);
 *   2. `set lock_timeout = '180s'` runs before the drop (the lint floor exists
 *      because the CONCURRENTLY statement waits for every transaction that
 *      began before it);
 *   3. the drop is one statement naming the index, IF EXISTS so a re-run after
 *      a partial failure is safe;
 *   4. the migration still marks itself applied in pgmigrations.
 */

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const MIGRATION_SUFFIX = 'drop_projects_updated_index.concurrent.ts';

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
  const dir = mkdtempSync(join(tmpdir(), 'krtx-1202-migration-'));
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

describe('drop_projects_updated_index migration — node-pg-migrate batch contract', () => {
  test('COMMIT breaks the batch; lock_timeout then the single-statement drop run after it; migration marks itself applied', async () => {
    const texts = await runMigrationInBatch(recordingClient());

    const commit = texts.findIndex((t) => t.trim() === 'COMMIT;');
    expect(commit).toBeGreaterThan(-1);

    const lockTimeout = texts.findIndex((t) => /set lock_timeout = '180s'/i.test(t));
    expect(lockTimeout).toBeGreaterThan(commit);

    const drop = texts.filter((t) => t.includes('drop index concurrently'));
    expect(drop).toHaveLength(1);
    // The exact statement: right index, IF EXISTS so a re-run after a partial
    // failure is safe (a mutated name must fail here, not pass a substring
    // match).
    expect(drop[0].trim()).toBe('drop index concurrently if exists kortix.idx_projects_updated;');
    // Exactly one statement per query: one trailing semicolon, nothing else.
    expect(drop[0].split(';').length).toBe(2);
    expect(texts.indexOf(drop[0])).toBeGreaterThan(lockTimeout);

    const markApplied = texts.findIndex(
      (t) =>
        /insert into "public"\."pgmigrations"/i.test(t) &&
        t.includes('drop_projects_updated_index'),
    );
    expect(markApplied).toBeGreaterThan(texts.indexOf(drop[0]));
  });
});
