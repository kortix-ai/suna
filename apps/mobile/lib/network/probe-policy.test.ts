import { describe, expect, test } from 'bun:test';

import {
  OFFLINE_PROBE_INTERVAL_MS,
  ONLINE_PROBE_INTERVAL_MS,
  nextFailureCount,
  nextProbeDelay,
  shouldShowOffline,
} from './probe-policy';

describe('probe policy', () => {
  test('interval values', () => {
    expect(ONLINE_PROBE_INTERVAL_MS).toBe(60_000);
    expect(OFFLINE_PROBE_INTERVAL_MS).toBe(10_000);
  });

  test('a successful probe waits the online interval', () => {
    expect(nextProbeDelay(true, 0)).toBe(60_000);
  });

  test('a failed probe re-checks after the offline interval', () => {
    expect(nextProbeDelay(false, 1)).toBe(10_000);
    expect(nextProbeDelay(false, 2)).toBe(10_000);
    expect(nextProbeDelay(false, 30)).toBe(10_000);
  });

  test('success resets the failure count; failure increments it', () => {
    expect(nextFailureCount(5, true)).toBe(0);
    expect(nextFailureCount(0, false)).toBe(1);
    expect(nextFailureCount(1, false)).toBe(2);
  });

  test('the banner shows only after two consecutive failures', () => {
    expect(shouldShowOffline(0)).toBe(false);
    expect(shouldShowOffline(1)).toBe(false);
    expect(shouldShowOffline(2)).toBe(true);
    expect(shouldShowOffline(7)).toBe(true);
  });
});
