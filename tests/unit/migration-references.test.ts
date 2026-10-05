import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A migration that is renamed (for example to fix the migration order) must
// take every reference with it. #8927 and #9075 renamed their migrations but
// their integration tests still opened the old file, so `main`'s db-suites lane
// failed with ENOENT until #9158 and #9159. This check runs in seconds, without
// a database.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const REFERENCE = /migrations\/(\d{14,17}_[a-z0-9_]+\.sql)/g;

function git(args: string[]): string[] {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    // `git grep` exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

export function missingMigrationReferences(lines: string[], sqlFiles: Set<string>): string[] {
  const missing: string[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(REFERENCE)) {
      if (!sqlFiles.has(match[1]!)) missing.push(`${line.split(':').slice(0, 2).join(':')} → ${match[1]}`);
    }
  }
  return missing;
}

describe('migration file references', () => {
  it('reports a reference to a migration that does not exist', () => {
    const files = new Set(['20261004173000002_policy_roles.sql']);
    expect(
      missingMigrationReferences(
        [
          "a.test.ts:12:  '../migrations/20261004002924533_policy_roles.sql',",
          "b.test.ts:3:  '../migrations/20261004173000002_policy_roles.sql',",
        ],
        files,
      ),
    ).toEqual(['a.test.ts:12 → 20261004002924533_policy_roles.sql']);
  });

  it('every migration path in TypeScript and JavaScript names a tracked .sql file', () => {
    const sqlFiles = new Set(git(['ls-files', '*.sql']).map((path) => basename(path)));
    const lines = git(['grep', '-nE', 'migrations/[0-9]{14,17}_[a-z0-9_]+\\.sql', '--', '*.ts', '*.tsx', '*.js', '*.mjs']);
    expect(missingMigrationReferences(lines, sqlFiles)).toEqual([]);
  });
});
