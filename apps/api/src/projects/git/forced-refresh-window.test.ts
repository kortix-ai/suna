// WHETHER A SECOND FORCED MIRROR REFRESH HAS TO GO TO THE NETWORK.
//
// Measured on dev 2026-09-09 inside the API container, authenticated the way the
// API authenticates: `git fetch --prune` 450-523 ms, `git ls-remote` 461-538 ms,
// `git --version` 3-9 ms. The half-second is one round trip to GitHub, and a
// cheap pre-check is not cheaper. Session create forces one (loadProjectAgents)
// and the first prompt forces another (remintGrant) seconds later.
import { describe, expect, test } from 'bun:test';
import { planForcedRefresh } from './forced-refresh-window';

const plan = (sinceLastForcedMs: number, windowMs = 5_000) =>
  planForcedRefresh({ sinceLastForcedMs, windowMs });

describe('a forced mirror refresh that just happened', () => {
  test('is reused inside the window — the second caller cannot see a different remote', () => {
    expect(plan(0)).toBe('reuse_recent_force');
    expect(plan(120)).toBe('reuse_recent_force');
    expect(plan(4_999)).toBe('reuse_recent_force');
  });

  test('and is NOT reused past it', () => {
    expect(plan(5_000)).toBe('fetch');
    expect(plan(60_000)).toBe('fetch');
  });

  test('a window of zero disables this entirely — the default', () => {
    // Every force does its own round trip, exactly as before.
    expect(plan(0, 0)).toBe('fetch');
    expect(plan(1, 0)).toBe('fetch');
    expect(plan(0, -1)).toBe('fetch');
    expect(plan(0, Number.NaN)).toBe('fetch');
  });

  test('an unreadable age fetches, because reusing wrongly is the worse error', () => {
    // Half a second is the cost of an extra fetch. A stale answer to a caller
    // that explicitly asked not to have one is the cost of guessing.
    expect(plan(Number.NaN)).toBe('fetch');
    expect(plan(-1)).toBe('fetch');
    expect(plan(Number.POSITIVE_INFINITY)).toBe('fetch');
  });
});
