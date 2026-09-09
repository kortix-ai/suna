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
  planForcedRefresh({ sinceLastForcedMs, windowMs, sinceLastTurnEndMs: null });

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

describe('a forced refresh taken after the last turn ended', () => {
  const p = (sinceLastForcedMs: number, sinceLastTurnEndMs: number | null, windowMs = 5_000) =>
    planForcedRefresh({ sinceLastForcedMs, windowMs, sinceLastTurnEndMs });

  test('is reused however old it is — no turn has run to change the manifest since', () => {
    // The refresh is 10 minutes old; the last turn ended 20 minutes ago. Nothing
    // this deployment runs has touched kortix.yaml in between. Measured on dev
    // 2026-09-09: the clock window alone re-fetched here for 534 ms.
    expect(p(600_000, 1_200_000)).toBe('reuse_recent_force');
    expect(p(86_400_000, 86_500_000)).toBe('reuse_recent_force');
  });

  test('but a turn that ended AFTER it invalidates it — that is the whole guarantee', () => {
    // Refresh 10 minutes ago, turn ended 5 minutes ago: that turn could have
    // narrowed the manifest and this reader must not miss it.
    expect(p(600_000, 300_000)).toBe('fetch');
  });

  test('a tie does NOT earn the unbounded reuse — same millisecond, unknown order', () => {
    // It falls back to the clock window rather than trusting the ordering, so a
    // tie inside the window still reuses and a tie outside it fetches.
    expect(p(1_000, 1_000)).toBe('reuse_recent_force');
    expect(p(600_000, 600_000)).toBe('fetch');
  });

  test('with no turn end observed it is the clock window, unchanged', () => {
    expect(p(1_000, null)).toBe('reuse_recent_force');
    expect(p(9_000, null)).toBe('fetch');
  });

  test('and coalescing off still means every force fetches', () => {
    // The turn-end signal must not smuggle reuse past the operator switch.
    expect(p(600_000, 1_200_000, 0)).toBe('fetch');
  });
});

describe('the state a turn end leaves behind', () => {
  test('with no forced refresh recorded at all, a force fetches', () => {
    // `noteTurnEnded` drops the previous forced stamp, so this is what the
    // warm-up itself sees — and it must go to the network, or nothing is warmed.
    expect(
      planForcedRefresh({
        sinceLastForcedMs: Number.NaN,
        windowMs: 60_000,
        sinceLastTurnEndMs: 0,
      }),
    ).toBe('fetch');
  });
});
