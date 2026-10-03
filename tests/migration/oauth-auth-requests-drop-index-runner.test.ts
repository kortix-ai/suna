// KRTX-1189: 20261003091115049_drop_oauth_auth_requests_expires_index.concurrent.ts
// drops the Supabase-advisor-flagged unused index (idx_scan = 0 on prod) with
// `drop index concurrently`. This file proves its node-pg-migrate runner
// contract with the REAL runner against a recording client, no database (the
// house pattern of invitations-invited-by-index-migration.test.ts):
//
//   1. pgm.noTransaction() splices the batch runner's COMMIT before this
//      migration's statements — a statement issued during up() (or inside a
//      multi-statement string) instead runs inside the still-open single
//      transaction and CONCURRENTLY fails with 25001 PreventInTransactionBlock
//      (learnings 2026-10-02; MIGRATIONS.md "Roll-forward safety");
//   2. each statement is exactly one statement per query;
//   3. the migration marks itself applied.
//
//   bun test tests/migration/oauth-auth-requests-drop-index-runner.test.ts
import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'packages', 'db', 'migrations');
const MIGRATION_SUFFIX = 'drop_oauth_auth_requests_expires_index.concurrent.ts';

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

async function runMigrationInBatch(): Promise<string[]> {
  const { client, statements } = recordingClient();
  const dir = mkdtempSync(join(tmpdir(), 'krtx-1189-migration-'));
  try {
    const file = readdirSync(MIGRATIONS_DIR).find((f) => f.endsWith(MIGRATION_SUFFIX));
    if (!file) throw new Error(`migration file ${MIGRATION_SUFFIX} not found in ${MIGRATIONS_DIR}`);
    copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
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

describe('drop_oauth_auth_requests_expires_index — node-pg-migrate batch contract', () => {
  test('the concurrent drop is queued single-statement after the batch COMMIT, and marks itself applied', async () => {
    const statements = await runMigrationInBatch();

    const batchCommit = statements.findIndex((t) => t.trim() === 'COMMIT;');
    expect(batchCommit).toBeGreaterThan(-1);

    const concurrent = statements.filter((t) => t.includes('drop index concurrently'));
    expect(concurrent).toHaveLength(1);
    expect(concurrent[0]).toContain('kortix.idx_oauth_auth_requests_expires');
    // Exactly one statement per query: one trailing semicolon, nothing else.
    expect(concurrent[0].split(';').length).toBe(2);
    expect(statements.indexOf(concurrent[0])).toBeGreaterThan(batchCommit);

    expect(statements.some((t) => /set lock_timeout = '180s'/i.test(t))).toBe(true);
    expect(statements.some((t) => /set statement_timeout = '30min'/i.test(t))).toBe(true);

    expect(
      statements.some(
        (t) =>
          /insert into "public"\."pgmigrations"/i.test(t) &&
          t.includes('drop_oauth_auth_requests_expires_index'),
      ),
    ).toBe(true);
  });
});
