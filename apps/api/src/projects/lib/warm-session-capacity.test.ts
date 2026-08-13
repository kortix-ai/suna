/**
 * The warm-session concurrency guard.
 *
 * A warm session sits at `provisioning`, which `countActiveProjectSessions`
 * counts, so speculative warming could consume the LAST concurrent-session slot
 * and 429 the next genuine session start. The guard keeps one slot free — and
 * governs CREATE only, never reuse.
 */
import { describe, expect, test } from 'bun:test';
import {
  assertWarmSessionCapacity,
  warmSessionCreateFitsCap,
  WarmProjectSessionUnavailableError,
} from './warm-session-capacity';

const ACCOUNT = '00000000-0000-4000-a000-0000000000aa';

describe('warmSessionCreateFitsCap', () => {
  test('warms while a free slot would remain after the create', () => {
    // Starter: concurrentSessionLimit 3 (billing/services/tiers.ts:263).
    expect(warmSessionCreateFitsCap(0, 3)).toBe(true);
    expect(warmSessionCreateFitsCap(1, 3)).toBe(true);
  });

  test('refuses the second-to-last slot — the boundary this guard exists for', () => {
    expect(warmSessionCreateFitsCap(2, 3)).toBe(false);
  });

  test('refuses at and above the cap', () => {
    expect(warmSessionCreateFitsCap(3, 3)).toBe(false);
    expect(warmSessionCreateFitsCap(4, 3)).toBe(false);
  });

  test('a one-slot account never warms — its only slot belongs to real work', () => {
    expect(warmSessionCreateFitsCap(0, 1)).toBe(false);
  });

  test('a zero or negative limit never warms', () => {
    expect(warmSessionCreateFitsCap(0, 0)).toBe(false);
    expect(warmSessionCreateFitsCap(0, -1)).toBe(false);
  });

  test('billing off resolves to MAX_SAFE_INTEGER and always warms', () => {
    // resolveAccountSessionLimit returns this when
    // KORTIX_BILLING_INTERNAL_ENABLED is off (shared/account-limits.ts:155).
    expect(warmSessionCreateFitsCap(9, Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe('assertWarmSessionCapacity', () => {
  test('resolves when a free slot would remain', async () => {
    expect(
      await assertWarmSessionCapacity(ACCOUNT, {
        resolveLimit: async () => ({ tier: 'starter', limit: 3, source: 'tier' }),
        countActive: async () => 1,
      }),
    ).toBeUndefined();
  });

  test('throws WARM_SESSION_UNAVAILABLE at the boundary, with the reason', async () => {
    const error = await assertWarmSessionCapacity(ACCOUNT, {
      resolveLimit: async () => ({ tier: 'starter', limit: 3, source: 'tier' }),
      countActive: async () => 2,
    }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(WarmProjectSessionUnavailableError);
    expect((error as WarmProjectSessionUnavailableError).reason).toBe(
      'concurrent_session_headroom',
    );
  });

  test('honours a per-account operator override, not only the tier', async () => {
    const error = await assertWarmSessionCapacity(ACCOUNT, {
      resolveLimit: async () => ({ tier: 'free', limit: 2, source: 'account_override' }),
      countActive: async () => 1,
    }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(WarmProjectSessionUnavailableError);
  });

  test('reads the limit and the count for the account it was asked about', async () => {
    const seen: string[] = [];
    await assertWarmSessionCapacity(ACCOUNT, {
      resolveLimit: async (accountId) => {
        seen.push(accountId);
        return { tier: 'starter', limit: 3, source: 'tier' };
      },
      countActive: async (accountId) => {
        seen.push(accountId);
        return 0;
      },
    });
    expect(seen).toEqual([ACCOUNT, ACCOUNT]);
  });
});
