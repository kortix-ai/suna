import { describe, expect, test } from 'bun:test';

import { fileHistoryRetry } from './use-file-history';

/**
 * The retry predicate runs on whatever `queryFn` rejected with — React Query
 * does not guarantee an `Error` with a string `message`. A non-string message
 * previously crashed here with `TypeError: t.message.includes is not a
 * function`, killing the query's retry loop for the file-history popover.
 */
describe('fileHistoryRetry', () => {
  test('does not retry "not a git repository" or "does not exist" rejections', () => {
    expect(
      fileHistoryRetry(0, new Error('fatal: not a git repository (or any of the parent dirs)')),
    ).toBe(false);
    expect(fileHistoryRetry(0, new Error('path /src/app.tsx does not exist'))).toBe(false);
  });

  test('retries other failures up to twice', () => {
    expect(fileHistoryRetry(0, new Error('network interrupted'))).toBe(true);
    expect(fileHistoryRetry(1, new Error('network interrupted'))).toBe(true);
    expect(fileHistoryRetry(2, new Error('network interrupted'))).toBe(false);
  });

  test('a non-string message rejection does not crash the retry loop', () => {
    const notAnError = { message: { code: 'ENOENT' } } as unknown as Error;
    expect(fileHistoryRetry(0, notAnError)).toBe(true);
    expect(fileHistoryRetry(2, notAnError)).toBe(false);
  });

  test('a rejected plain string does not crash the retry loop', () => {
    const rejected = 'not a git repository: /workspace' as unknown as Error;
    expect(fileHistoryRetry(0, rejected)).toBe(true);
  });
});
