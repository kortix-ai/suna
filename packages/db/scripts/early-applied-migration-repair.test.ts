import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EARLY_APPLIED_MIGRATIONS,
  migrationNamesInDirectory,
  planEarlyAppliedMigrationRepair,
} from './early-applied-migration-repair';

const KEYSET = '20260916150159063_session_list_keyset_index.concurrent';
const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const files = migrationNamesInDirectory(MIGRATIONS_DIR);
const before = files.filter((name) => name < KEYSET);

describe('planEarlyAppliedMigrationRepair', () => {
  test('releases the keyset ledger row when older migrations are still pending', () => {
    // Staging and prod v0.13.20: the targeted #7314 release ran the keyset
    // index before seven migrations with older timestamps existed there.
    const ledger = [
      ...before.filter(
        (name) =>
          ![
            '20260914201549272_user_provider_connections',
            '20260916130042262_prompt_attachments',
          ].includes(name),
      ),
      KEYSET,
    ];
    expect(planEarlyAppliedMigrationRepair(ledger, files)).toEqual([KEYSET]);
  });

  test('does nothing when every older migration is applied', () => {
    expect(planEarlyAppliedMigrationRepair([...before, KEYSET], files)).toEqual([]);
  });

  test('does nothing when the keyset migration is not applied yet', () => {
    expect(planEarlyAppliedMigrationRepair(before.slice(0, -1), files)).toEqual([]);
    expect(planEarlyAppliedMigrationRepair([], files)).toEqual([]);
  });

  test('only lists idempotent concurrent migrations with a pinned checksum', () => {
    for (const migration of EARLY_APPLIED_MIGRATIONS) {
      expect(migration.filename.endsWith('.concurrent.ts')).toBe(true);
      const source = readFileSync(join(MIGRATIONS_DIR, migration.filename), 'utf-8');
      expect(source).toContain('if not exists');
      expect(createHash('sha256').update(source).digest('hex')).toBe(migration.sha256);
    }
  });
});
