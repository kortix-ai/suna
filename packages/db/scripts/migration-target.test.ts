import { describe, expect, test } from 'bun:test';
import { migrationCheckOrder } from './migration-target';

describe('migration target mode', () => {
  test('keeps migration ordering strict for normal commands', () => {
    expect(migrationCheckOrder('up', 'postgresql://user:pass@db.example.com/app')).toBe(true);
    expect(migrationCheckOrder('status', 'postgresql://user:pass@127.0.0.1:5432/app')).toBe(true);
  });

  test('allows out-of-order migrations only for a loopback local-up target', () => {
    expect(migrationCheckOrder('local-up', 'postgresql://user:pass@127.0.0.1:5432/app')).toBe(false);
    expect(migrationCheckOrder('local-up', 'postgresql://user:pass@localhost:5432/app')).toBe(false);
  });

  test('rejects local-up for remote and invalid database URLs', () => {
    expect(() => migrationCheckOrder('local-up', 'postgresql://user:pass@db.example.com/app')).toThrow(
      'local-up refuses non-loopback database host: db.example.com',
    );
    expect(() => migrationCheckOrder('local-up', 'not-a-url')).toThrow(
      'local-up requires a valid loopback DATABASE_URL',
    );
  });
});
