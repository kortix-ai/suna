import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validatedMigrationTempDirectory,
  validatedMigrationTempFile,
} from './migration-temp-paths';

describe('migration temporary checkpoint validation', () => {
  test('accepts generated migration paths under the platform temporary directory', () => {
    const bundle = join(tmpdir(), 'suna-mig-random');
    const database = join(tmpdir(), 'suna-db-random', 'opencode.db');
    expect(validatedMigrationTempDirectory(bundle, 'suna-mig-')).toBe(bundle);
    expect(validatedMigrationTempFile(database, 'suna-db-', 'opencode.db')).toBe(database);
  });

  test.each([
    '/etc',
    join(tmpdir(), 'suna-mig-../etc'),
    join(tmpdir(), 'other-random'),
    join(tmpdir(), 'suna-mig-random', 'nested'),
  ])('rejects an unsafe bundle checkpoint: %s', (value) => {
    expect(validatedMigrationTempDirectory(value, 'suna-mig-')).toBeNull();
  });

  test.each([
    '/etc/passwd',
    join(tmpdir(), 'suna-db-random', 'other.db'),
    join(tmpdir(), 'other-random', 'opencode.db'),
    join(tmpdir(), 'suna-db-random', 'nested', 'opencode.db'),
  ])('rejects an unsafe database checkpoint: %s', (value) => {
    expect(validatedMigrationTempFile(value, 'suna-db-', 'opencode.db')).toBeNull();
  });
});
