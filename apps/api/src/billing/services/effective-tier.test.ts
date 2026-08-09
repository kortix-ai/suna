import { describe, expect, test } from 'bun:test';
import {
  activeTrialSeatLimit,
  coercePerSeatTier,
  resolveEffectiveTier,
  TRIAL_STATUS,
  trialIsActive,
} from './effective-tier';

const NOW = Date.parse('2026-08-07T12:00:00Z');
const FUTURE = new Date(NOW + 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(NOW - 1000).toISOString();

const activeTrial = {
  trialStatus: TRIAL_STATUS.ACTIVE,
  trialTier: 'team',
  trialSeats: 5,
  trialStartedAt: PAST,
  trialEndsAt: FUTURE,
};

describe('trialIsActive', () => {
  test('active trial with future end date grants', () => {
    expect(trialIsActive(activeTrial, NOW)).toBe(true);
  });

  test('lapses lazily the instant trial_ends_at passes', () => {
    expect(trialIsActive({ ...activeTrial, trialEndsAt: PAST }, NOW)).toBe(false);
    expect(trialIsActive(activeTrial, Date.parse(FUTURE))).toBe(false);
  });

  test.each([
    TRIAL_STATUS.NONE,
    TRIAL_STATUS.EXPIRED,
    TRIAL_STATUS.REVOKED,
    TRIAL_STATUS.CONVERTED,
  ])('status %s never grants', (status) => {
    expect(trialIsActive({ ...activeTrial, trialStatus: status }, NOW)).toBe(false);
  });

  test('unknown or missing trial tier never grants', () => {
    expect(trialIsActive({ ...activeTrial, trialTier: 'not_a_tier' }, NOW)).toBe(false);
    expect(trialIsActive({ ...activeTrial, trialTier: null }, NOW)).toBe(false);
  });

  test('missing row or end date never grants', () => {
    expect(trialIsActive(null, NOW)).toBe(false);
    expect(trialIsActive({ ...activeTrial, trialEndsAt: null }, NOW)).toBe(false);
    expect(trialIsActive({ ...activeTrial, trialEndsAt: 'garbage' }, NOW)).toBe(false);
  });
});

describe('resolveEffectiveTier', () => {
  test('active trial overlays the stored tier', () => {
    expect(resolveEffectiveTier({ tier: 'free', ...activeTrial }, NOW)).toBe('team');
  });

  test('expired trial falls back to the stored tier', () => {
    expect(
      resolveEffectiveTier({ tier: 'free', ...activeTrial, trialEndsAt: PAST }, NOW),
    ).toBe('free');
  });

  test('revoked trial falls back to the stored tier', () => {
    expect(
      resolveEffectiveTier(
        { tier: 'pro', ...activeTrial, trialStatus: TRIAL_STATUS.REVOKED },
        NOW,
      ),
    ).toBe('pro');
  });

  test('no row resolves fail-closed to none', () => {
    expect(resolveEffectiveTier(null, NOW)).toBe('none');
    expect(resolveEffectiveTier(undefined, NOW)).toBe('none');
  });

  test('per-seat self-heal applies when no trial is active', () => {
    expect(
      resolveEffectiveTier(
        {
          tier: 'free',
          billingModel: 'per_seat',
          stripeSubscriptionId: 'sub_1',
          stripeSubscriptionStatus: 'active',
        },
        NOW,
      ),
    ).toBe('per_seat');
  });

  test('active trial wins over the per-seat self-heal', () => {
    expect(
      resolveEffectiveTier(
        {
          tier: 'free',
          billingModel: 'per_seat',
          stripeSubscriptionId: 'sub_1',
          stripeSubscriptionStatus: 'active',
          ...activeTrial,
          trialTier: 'enterprise',
        },
        NOW,
      ),
    ).toBe('enterprise');
  });
});

describe('coercePerSeatTier', () => {
  test('keeps a paid tier untouched', () => {
    expect(
      coercePerSeatTier('pro', {
        billingModel: 'per_seat',
        stripeSubscriptionId: 'sub_1',
        stripeSubscriptionStatus: 'active',
      }),
    ).toBe('pro');
  });

  test('does not coerce dead subscriptions', () => {
    for (const status of ['canceled', 'unpaid']) {
      expect(
        coercePerSeatTier('free', {
          billingModel: 'per_seat',
          stripeSubscriptionId: 'sub_1',
          stripeSubscriptionStatus: status,
        }),
      ).toBe('free');
    }
  });

  test('defaults a missing tier to free', () => {
    expect(coercePerSeatTier(null, null)).toBe('free');
  });
});

describe('activeTrialSeatLimit', () => {
  test('returns the seat allowance while active', () => {
    expect(activeTrialSeatLimit(activeTrial, NOW)).toBe(5);
  });

  test('returns null when the trial is not active', () => {
    expect(activeTrialSeatLimit({ ...activeTrial, trialEndsAt: PAST }, NOW)).toBeNull();
    expect(activeTrialSeatLimit(null, NOW)).toBeNull();
  });

  test('returns null for uncapped or invalid seat values', () => {
    expect(activeTrialSeatLimit({ ...activeTrial, trialSeats: null }, NOW)).toBeNull();
    expect(activeTrialSeatLimit({ ...activeTrial, trialSeats: 0 }, NOW)).toBeNull();
    expect(activeTrialSeatLimit({ ...activeTrial, trialSeats: -3 }, NOW)).toBeNull();
  });

  test('floors fractional seat values', () => {
    expect(activeTrialSeatLimit({ ...activeTrial, trialSeats: 5.9 }, NOW)).toBe(5);
  });
});
