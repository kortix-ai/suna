import { describe, expect, test } from 'bun:test';
import { removalBackoffMs, shouldAttemptRemoval } from './archived-box-removal';

const NOW = new Date('2026-09-24T12:00:00.000Z');

describe('archived-box removal retry schedule', () => {
  test('backs off exponentially from one minute to a six-hour ceiling, never giving up', () => {
    expect(removalBackoffMs(1)).toBe(60_000);
    expect(removalBackoffMs(2)).toBe(120_000);
    expect(removalBackoffMs(5)).toBe(16 * 60_000);
    expect(removalBackoffMs(50)).toBe(6 * 60 * 60_000);
  });

  test('a row is retried only when its retry time has come', () => {
    const nowMs = NOW.getTime();
    expect(shouldAttemptRemoval({ providerAllowed: true, retryAfterMs: null, nowMs })).toBe(true);
    expect(shouldAttemptRemoval({ providerAllowed: true, retryAfterMs: nowMs - 1, nowMs })).toBe(true);
    expect(shouldAttemptRemoval({ providerAllowed: true, retryAfterMs: nowMs + 1, nowMs })).toBe(false);
    expect(shouldAttemptRemoval({ providerAllowed: false, retryAfterMs: null, nowMs })).toBe(false);
  });
});
