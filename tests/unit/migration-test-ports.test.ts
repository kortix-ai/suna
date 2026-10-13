import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The DB suites run concurrently (`tests/bin/db-suites.ts`). A migration test
// that starts a throwaway Postgres publishes it on a fixed host port, so two
// files with the same default port fail whichever starts second: `Bind for
// 127.0.0.1:<port> failed: port is already allocated`. #9106 and #8935 both
// took 5449, one day apart.

const MIGRATION_TESTS = join(import.meta.dirname, '..', 'migration');

describe('migration test containers', () => {
  it('every throwaway Postgres has its own default host port', () => {
    const owners = new Map<number, string[]>();
    for (const file of readdirSync(MIGRATION_TESTS).filter((name) => name.endsWith('.test.ts'))) {
      const source = readFileSync(join(MIGRATION_TESTS, file), 'utf8');
      for (const match of source.matchAll(/_PORT \|\| (\d{4,5})\)/g)) {
        const port = Number(match[1]);
        owners.set(port, [...(owners.get(port) ?? []), file]);
      }
    }
    expect(owners.size).toBeGreaterThan(0);
    expect([...owners].filter(([, files]) => files.length > 1)).toEqual([]);
  });
});
