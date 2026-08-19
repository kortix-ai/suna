import { describe, expect, test } from 'bun:test';
import {
  inspectDatabaseError,
  isTransientDatabaseError,
  retryTransientDatabaseRead,
} from './database-errors';

function wrappedDatabaseError(code: string, message: string): Error {
  return new Error('Failed query: select 1', {
    cause: Object.assign(new Error(message), {
      name: 'PostgresError',
      code,
      severity: 'FATAL',
      table: 'iam_policies',
      schema_name: 'kortix',
      detail: 'provider detail',
      hint: 'provider hint',
    }),
  });
}

describe('inspectDatabaseError', () => {
  test('extracts PostgreSQL fields from a wrapped Drizzle cause', () => {
    const error = wrappedDatabaseError('08006', 'connection failure');
    error.name = 'DrizzleQueryError';

    expect(inspectDatabaseError(error)).toEqual({
      isDatabaseError: true,
      outerName: 'DrizzleQueryError',
      outerMessage: 'Failed query: select 1',
      causeName: 'PostgresError',
      causeMessage: 'connection failure',
      pgCode: '08006',
      severity: 'FATAL',
      table: 'iam_policies',
      schema: 'kortix',
      detail: 'provider detail',
      hint: 'provider hint',
    });
  });

  test('reads a unique_violation (23505) off the wrapped cause — the App-create 409 path', () => {
    // Drizzle wraps postgres.js, so the SQLSTATE is on error.cause.code, never
    // error.code. The old `(error as {code?}).code === '23505'` check was dead
    // (undefined) and duplicate-slug App creates returned 500 instead of 409.
    const error = wrappedDatabaseError('23505', 'duplicate key value violates unique constraint');
    expect((error as { code?: string }).code).toBeUndefined(); // why the old check never fired
    expect(inspectDatabaseError(error)?.pgCode).toBe('23505');
  });

  test('rejects an application error with no database signal', () => {
    expect(inspectDatabaseError(new Error('invalid project state'))).toBeNull();
  });
});

describe('isTransientDatabaseError', () => {
  test.each([
    ['08006', 'connection failure'],
    ['40001', 'serialization failure'],
    ['40P01', 'deadlock detected'],
    ['53300', 'too many connections'],
    ['57P03', 'cannot connect now'],
    ['EMAXCONNSESSION', 'max clients reached in session mode'],
  ])('accepts retryable PostgreSQL code %s', (code, message) => {
    expect(isTransientDatabaseError(wrappedDatabaseError(code, message))).toBe(true);
  });

  test('rejects a schema failure', () => {
    expect(
      isTransientDatabaseError(wrappedDatabaseError('42P01', 'relation does not exist')),
    ).toBe(false);
  });
});

describe('retryTransientDatabaseRead', () => {
  test('retries one transient failure and returns the second result', async () => {
    let calls = 0;
    const result = await retryTransientDatabaseRead(async () => {
      calls += 1;
      if (calls === 1) {
        throw wrappedDatabaseError('08006', 'connection failure');
      }
      return ['allowed'];
    });

    expect(result).toEqual(['allowed']);
    expect(calls).toBe(2);
  });

  test('does not retry a non-transient database failure', async () => {
    let calls = 0;
    await expect(
      retryTransientDatabaseRead(async () => {
        calls += 1;
        throw wrappedDatabaseError('42P01', 'relation does not exist');
      }),
    ).rejects.toThrow('Failed query');
    expect(calls).toBe(1);
  });
});
