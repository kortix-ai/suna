import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';

/**
 * Runtime contract of 20261003060242827_drop_tunnel_permissions_unused_status_index.concurrent.ts
 * with node-pg-migrate's single-transaction batch runner — proven against the
 * REAL runner with a recording client, no database (same pattern as
 * invitations-invited-by-index-migration.test.ts):
 *
 *   1. the `drop index concurrently` runs AFTER the runner's COMMIT —
 *      CONCURRENTLY cannot run inside any transaction block, and a plain .sql
 *      migration would run it inside one (MIGRATIONS.md "Roll-forward safety");
 *   2. it is a single statement per query — a multi-statement string re-wraps
 *      itself in an implicit transaction and fails the same way;
 *   3. the 180s lock_timeout and 30min statement_timeout are set before the
 *      drop, so the wait budget governs the CONCURRENTLY wait (learnings
 *      2026-08-19);
 *   4. the migration still marks itself applied in the ledger.
 */

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const MIGRATION_SUFFIX = 'drop_tunnel_permissions_unused_status_index.concurrent.ts';
const DROP = 'drop index concurrently if exists kortix.idx_tunnel_permissions_status';

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
  const dir = mkdtempSync(join(tmpdir(), 'krtx-1212-migration-'));
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

describe('drop_tunnel_permissions_unused_status_index migration — node-pg-migrate batch contract', () => {
  test('the drop runs single-statement after COMMIT, behind both timeouts', async () => {
    const texts = await runMigrationInBatch(recordingClient());

    const batchCommit = texts.findIndex((t) => t.trim() === 'COMMIT;');
    // node-pg-migrate sends each pgm.sql() string with a trailing semicolon.
    const drop = texts.findIndex((t) => t.trim() === `${DROP};`);
    expect(batchCommit).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(batchCommit);

    // Exactly one statement per query: one trailing semicolon, nothing else.
    expect(texts[drop].split(';').length).toBe(2);

    const lockTimeout = texts.findIndex((t) => /set lock_timeout = '180s'/i.test(t));
    const statementTimeout = texts.findIndex((t) => /set statement_timeout = '30min'/i.test(t));
    expect(lockTimeout).toBeGreaterThan(-1);
    expect(statementTimeout).toBeGreaterThan(-1);
    expect(lockTimeout).toBeLessThan(drop);
    expect(statementTimeout).toBeLessThan(drop);

    expect(
      texts.some(
        (t) =>
          /insert into "public"\."pgmigrations"/i.test(t) &&
          t.includes('drop_tunnel_permissions_unused_status_index'),
      ),
    ).toBe(true);
  });
});
