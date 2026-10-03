import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';

/**
 * Runtime contract of 20261003002832969_invitations_invited_by_index.concurrent.ts
 * with node-pg-migrate's single-transaction batch runner — proven against the
 * REAL runner with a recording client, no database:
 *
 *   1. the catalog probe (`to_regclass`) runs INSIDE the still-open batch
 *      transaction, before the runner's COMMIT;
 *   2. every `create index concurrently` runs AFTER that COMMIT (CONCURRENTLY
 *      cannot run inside any transaction block) and is a single statement per
 *      query — a multi-statement string re-wraps itself in an implicit
 *      transaction and fails the same way (MIGRATIONS.md "Roll-forward safety");
 *   3. when the table is absent (fresh self-host/CI databases build only the
 *      basejump.account_user stub), no DDL is issued at all and the migration
 *      still marks itself applied.
 */

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const MIGRATION_SUFFIX = 'invitations_invited_by_index.concurrent.ts';

/** Records every statement the runner executes; answers the catalog probe only. */
function recordingClient(invitationsPresent: boolean) {
  const statements: string[] = [];
  const client = {
    query(text: unknown) {
      const sql = typeof text === 'string' ? text : String((text as { text?: string })?.text ?? '');
      statements.push(sql);
      if (/to_regclass\('basejump\.invitations'\)/i.test(sql)) {
        return Promise.resolve({ rows: [{ present: invitationsPresent }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  return { client, statements };
}

async function runMigrationInBatch(
  recording: ReturnType<typeof recordingClient>,
): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'krtx-1087-migration-'));
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

describe('invitations_invited_by_index migration — node-pg-migrate batch contract', () => {
  test('probe runs inside the batch transaction; both index builds run single-statement after COMMIT', async () => {
    const texts = await runMigrationInBatch(recordingClient(true));

    const probe = texts.findIndex((t) => /to_regclass\('basejump\.invitations'\)/i.test(t));
    const batchCommit = texts.findIndex((t) => t.trim() === 'COMMIT;');
    expect(probe).toBeGreaterThan(-1);
    expect(batchCommit).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(batchCommit);

    const builds = texts.filter((t) => t.includes('create index concurrently'));
    expect(builds).toHaveLength(2);
    expect(builds.some((t) => /idx_invitations_invited_by_user_id/.test(t))).toBe(true);
    expect(builds.some((t) => /idx_invitations_account_id/.test(t))).toBe(true);
    for (const build of builds) {
      // Exactly one statement per query: one trailing semicolon, nothing else.
      expect(build.split(';').length).toBe(2);
      expect(texts.indexOf(build)).toBeGreaterThan(batchCommit);
    }
    expect(texts.some((t) => /set lock_timeout = '180s'/i.test(t))).toBe(true);
  });

  test('when basejump.invitations is absent, no DDL is issued and the migration still marks itself applied', async () => {
    const texts = await runMigrationInBatch(recordingClient(false));

    expect(texts.some((t) => /create index concurrently/i.test(t))).toBe(false);
    expect(
      texts.some(
        (t) =>
          /insert into "public"\."pgmigrations"/i.test(t) &&
          t.includes('invitations_invited_by_index'),
      ),
    ).toBe(true);
  });
});
