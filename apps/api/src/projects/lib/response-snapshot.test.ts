import { describe, expect, test } from 'bun:test';
import {
  RESPONSE_NOT_FOUND_ERROR,
  RESPONSE_SAVING_ERROR,
  publishedTooLarge,
  responseTitle,
  unloggedTurnResult,
} from './response-snapshot';

describe('unloggedTurnResult', () => {
  test('a turn the ledger recorded but the log has not received yet → 409, retry', () => {
    expect(unloggedTurnResult(true)).toEqual({ ok: false, status: 409, error: RESPONSE_SAVING_ERROR });
  });

  test('a turn nobody recorded → 404', () => {
    expect(unloggedTurnResult(false)).toEqual({ ok: false, status: 404, error: RESPONSE_NOT_FOUND_ERROR });
  });
});

describe('responseTitle', () => {
  test('the first markdown heading of the response, stripped', () => {
    expect(responseTitle('Intro line\n\n## **Q3** plan for `api`\n\nbody')).toBe('Q3 plan for api');
  });

  test('else the first non-empty line, markdown stripped', () => {
    expect(responseTitle('\n\n> Here is [the answer](https://x.test) in *short*.\nmore')).toBe('Here is the answer in short.');
  });

  test('at most 80 characters', () => {
    expect(responseTitle('a'.repeat(200))).toHaveLength(80);
  });

  test('never reads anything but the response text', () => {
    // The session title (auto title = a prompt excerpt) is not an input at all.
    expect(responseTitle.length).toBe(1);
  });
});

describe('publishedTooLarge', () => {
  test('response plus prompt over 256 kB (UTF-8 bytes) is too large', () => {
    expect(publishedTooLarge('a'.repeat(256 * 1024), null)).toBe(false);
    expect(publishedTooLarge('a'.repeat(256 * 1024), 'b')).toBe(true);
    // 3-byte characters count as 3 bytes.
    expect(publishedTooLarge('€'.repeat(90_000), null)).toBe(true);
  });
});
