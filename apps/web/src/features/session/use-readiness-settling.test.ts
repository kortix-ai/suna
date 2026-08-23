import { describe, expect, test } from 'bun:test';
import { READINESS_SETTLE_MS } from './use-readiness-settling';

describe('READINESS_SETTLE_MS', () => {
  // The window only buys silence for the first probe round trip. Anything
  // longer delays a REAL wake notice on a parked box, which is the state the
  // notice exists for.
  test('is short enough that a real wake still announces itself promptly', () => {
    expect(READINESS_SETTLE_MS).toBeLessThanOrEqual(2_000);
  });

  test('is long enough to cover a first health probe', () => {
    expect(READINESS_SETTLE_MS).toBeGreaterThanOrEqual(1_000);
  });
});
