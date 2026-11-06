import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unappliedMigrationFiles } from './prune-unapplied-migrations';
import { isMigrationFile, migrationNamesInDirectory } from './migration-files';

describe('isMigrationFile', () => {
  test('accepts .sql and .concurrent.ts only', () => {
    expect(isMigrationFile('a.sql')).toBe(true);
    expect(isMigrationFile('a.concurrent.ts')).toBe(true);
    for (const name of ['a.ts', 'a.test.ts', 'a.concurrent.test.ts', 'README.md']) {
      expect(isMigrationFile(name)).toBe(false);
    }
  });
});

describe('every enumerator agrees a .test.ts is not a migration', () => {
  const files = ['a.sql', 'b.concurrent.ts', 'c.test.ts', 'd.concurrent.test.ts'];

  test('migrationNamesInDirectory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migration-files-'));
    try {
      for (const name of files) writeFileSync(join(dir, name), '');
      expect(migrationNamesInDirectory(dir)).toEqual(['a', 'b.concurrent']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unappliedMigrationFiles', () => {
    expect(unappliedMigrationFiles(files, ['other'])).toEqual(['a.sql', 'b.concurrent.ts']);
  });
});
