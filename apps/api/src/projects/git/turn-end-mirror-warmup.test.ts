// WHEN THE MANIFEST FETCH SHOULD HAPPEN OFF THE PROMPT'S CRITICAL PATH.
//
// Measured on dev 2026-09-09 on pi-js.kortix.com: `remintGrant` 583 ms on the
// first prompt of a window and 13-17 ms on the next two, because the coalesce
// window served them. The fetch itself is one authenticated GitHub round trip
// (~490 ms) and the only thing that can invalidate it mid-session is the turn
// that just ended — so it belongs at turn end, not at prompt start.
import { describe, expect, test } from 'bun:test';
import { planTurnEndMirrorWarmup } from './turn-end-mirror-warmup';

const plan = (over: Partial<Parameters<typeof planTurnEndMirrorWarmup>[0]> = {}) =>
  planTurnEndMirrorWarmup({ terminal: true, coalesceWindowMs: 60_000, gitBacked: true, ...over });

describe('warming the mirror when a turn ends', () => {
  test('a turn that really ended warms it — the next prompt is the one that pays', () => {
    expect(plan()).toBe('warm');
  });

  test('a RETRYING turn does not — session.error fires on a 429 backoff too', () => {
    // Warming here fetches a manifest the turn has not finished writing, and the
    // real turn end would have to fetch again: two round trips, no latency won.
    expect(plan({ terminal: false })).toBe('skip');
  });

  test('with coalescing off it is pure cost — `force` then means one trip per caller', () => {
    // Nothing would reuse the warm fetch, so the next prompt goes to GitHub
    // anyway and the platform has doubled its traffic for the same wait.
    expect(plan({ coalesceWindowMs: 0 })).toBe('skip');
    expect(plan({ coalesceWindowMs: -1 })).toBe('skip');
    expect(plan({ coalesceWindowMs: Number.NaN })).toBe('skip');
  });

  test('a project with no mirror has nothing to warm', () => {
    expect(plan({ gitBacked: false })).toBe('skip');
  });

  test('every reason to skip is independent — one is enough', () => {
    expect(plan({ terminal: false, coalesceWindowMs: 60_000, gitBacked: true })).toBe('skip');
    expect(plan({ terminal: true, coalesceWindowMs: 0, gitBacked: true })).toBe('skip');
    expect(plan({ terminal: true, coalesceWindowMs: 60_000, gitBacked: false })).toBe('skip');
  });
});
