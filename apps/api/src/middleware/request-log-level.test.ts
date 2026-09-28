import { describe, expect, test } from 'bun:test';

import { requestCompletedLevel } from './request-log-level';

describe('requestCompletedLevel', () => {
  test('a successful response is info even when it is slow', () => {
    // Regression: a PUT that committed the manifest and re-synced connectors
    // returned 200 in 5982ms and was logged at warn. The log sweep filed that
    // as a new warn pattern (KRTX-641). A 2xx is not a failure.
    expect(requestCompletedLevel(200, 5982)).toBe('info');
    expect(requestCompletedLevel(200, 60_000)).toBe('info');
    expect(requestCompletedLevel(201, 30_000)).toBe('info');
    expect(requestCompletedLevel(304, 9_000)).toBe('info');
  });

  test('a 4xx stays info even when it is slow', () => {
    expect(requestCompletedLevel(400, 0)).toBe('info');
    expect(requestCompletedLevel(404, 12_000)).toBe('info');
    expect(requestCompletedLevel(429, 1_000)).toBe('info');
  });

  test('a 5xx is warn', () => {
    expect(requestCompletedLevel(500, 5)).toBe('warn');
    expect(requestCompletedLevel(503, 8_000)).toBe('warn');
  });
});
