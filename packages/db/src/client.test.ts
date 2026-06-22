import { describe, test, expect } from 'bun:test';
import { createDb } from './client';

describe('createDb input validation', () => {
  test('throws when the database url is an empty string', () => {
    expect(() => createDb('')).toThrow('DATABASE_URL is required');
  });

  test('does not throw synchronously for a well-formed connection string', () => {
    expect(() => createDb('postgres://user:pass@127.0.0.1:5432/does_not_connect_lazily')).not.toThrow();
  });

  test('returns a drizzle database client object', () => {
    const client = createDb('postgres://user:pass@127.0.0.1:5432/lazy');
    expect(client).toBeDefined();
    expect(typeof client.select).toBe('function');
  });
});
