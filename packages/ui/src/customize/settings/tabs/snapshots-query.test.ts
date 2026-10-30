import { describe, expect, test } from 'bun:test';

import { snapshotsQueryRetry } from './snapshots-query';

describe('snapshotsQueryRetry', () => {
  test('retries a timeout or 5xx once, then shows the error', () => {
    expect(snapshotsQueryRetry(0, new Error('timeout'))).toBe(true);
    expect(snapshotsQueryRetry(1, new Error('timeout'))).toBe(false);
    expect(snapshotsQueryRetry(0, { status: 503 })).toBe(true);
    expect(snapshotsQueryRetry(1, { status: 503 })).toBe(false);
  });

  test('never retries a 4xx', () => {
    expect(snapshotsQueryRetry(0, { status: 403 })).toBe(false);
    expect(snapshotsQueryRetry(0, { status: 404 })).toBe(false);
  });
});
