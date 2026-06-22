import { describe, expect, test } from 'bun:test';
import { isSweepStale, withTimeout } from '../projects/lib/triggers';

// These primitives are what keep one hung trigger fire from freezing the entire
// cron scheduler — the 2026-06-21 fleet-wide outage, where a single
// continueSession hung forever inside a sequential, un-timed sweep and every
// cron stopped firing for ~18h with no error.

describe('withTimeout', () => {
  test('resolves with the value when the promise settles before the timeout', async () => {
    expect(await withTimeout(Promise.resolve(42), 1000, 'fast')).toBe(42);
  });

  test('rejects with a labelled timeout error when the promise hangs past ms', async () => {
    const hang = new Promise<never>(() => {}); // never settles — models a hung fire
    await expect(withTimeout(hang, 20, 'stuck fire')).rejects.toThrow(/stuck fire timed out after 20ms/);
  });

  test('a slow-but-completing promise still resolves (no false timeout)', async () => {
    const slow = new Promise<string>((res) => setTimeout(() => res('done'), 10));
    expect(await withTimeout(slow, 500, 'slow')).toBe('done');
  });

  test('propagates the original rejection unchanged when the promise rejects first', async () => {
    const boom = Promise.reject(new Error('real failure'));
    await expect(withTimeout(boom, 500, 'x')).rejects.toThrow('real failure');
  });
});

describe('isSweepStale (scheduler stall detection)', () => {
  const T0 = 1_700_000_000_000;
  const STALE = 300_000; // 5 min window

  test('never stale when this pod is not the leader', () => {
    expect(
      isSweepStale({ isLeader: false, lastSweepStartedAt: null, lastSweepCompletedAt: null, nowMs: T0, staleMs: STALE }),
    ).toBe(false);
  });

  test('grace: leader but the scheduler has not ticked yet (no start) → not stale', () => {
    expect(
      isSweepStale({ isLeader: true, lastSweepStartedAt: null, lastSweepCompletedAt: null, nowMs: T0, staleMs: STALE }),
    ).toBe(false);
  });

  test('healthy: leader with a recently completed sweep → not stale', () => {
    expect(
      isSweepStale({
        isLeader: true,
        lastSweepStartedAt: new Date(T0 - 30_000).toISOString(),
        lastSweepCompletedAt: new Date(T0 - 29_000).toISOString(),
        nowMs: T0,
        staleMs: STALE,
      }),
    ).toBe(false);
  });

  test('IN-FLIGHT (fresh leader): first sweep started recently, not yet completed → NOT stale', () => {
    // Regression: a busy sweep can legitimately run for minutes (loads ~1.7k
    // project manifests). It must not read as stale the instant it starts just
    // because no prior sweep has completed yet (lastSweepCompletedAt is null).
    expect(
      isSweepStale({
        isLeader: true,
        lastSweepStartedAt: new Date(T0 - 30_000).toISOString(), // started 30s ago
        lastSweepCompletedAt: null,
        nowMs: T0,
        staleMs: STALE,
      }),
    ).toBe(false);
  });

  test('WEDGE: leader, a sweep in-flight far longer than the stale window → stale (the outage signature)', () => {
    expect(
      isSweepStale({
        isLeader: true,
        lastSweepStartedAt: new Date(T0 - 20 * 60_000).toISOString(),
        lastSweepCompletedAt: null,
        nowMs: T0,
        staleMs: STALE,
      }),
    ).toBe(true);
  });

  test('stale: leader whose last completed sweep is older than the stale window', () => {
    expect(
      isSweepStale({
        isLeader: true,
        lastSweepStartedAt: new Date(T0 - 11 * 60_000).toISOString(),
        lastSweepCompletedAt: new Date(T0 - 10 * 60_000).toISOString(),
        nowMs: T0,
        staleMs: STALE,
      }),
    ).toBe(true);
  });
});
