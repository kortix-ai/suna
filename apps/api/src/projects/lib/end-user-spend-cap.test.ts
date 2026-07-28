import { describe, expect, test } from 'bun:test';

import { decideSpendCap, spendCapError, spendWindowStart } from './end-user-spend-cap';

const base = { endUserRef: 'user-1', limitUsd: 10, windowDays: 30, spentUsd: 0 };

describe('decideSpendCap', () => {
  test('is OFF by default — an unset or zero limit never refuses', () => {
    // The cap must be opt-in: shipping it on would start 429ing every existing
    // deployment the moment it merged.
    expect(decideSpendCap({ ...base, limitUsd: 0, spentUsd: 1_000_000 })).toEqual({
      allowed: true,
      reason: 'disabled',
    });
  });

  test('a negative limit is treated as off, not as "refuse everything"', () => {
    expect(decideSpendCap({ ...base, limitUsd: -1, spentUsd: 5 }).allowed).toBe(true);
  });

  test('a session with no end-user is never capped', () => {
    // Only backend sessions carry a handle. Applying the account's spend to a
    // dashboard session would refuse ordinary interactive work.
    expect(decideSpendCap({ ...base, endUserRef: null, spentUsd: 99 })).toEqual({
      allowed: true,
      reason: 'no_end_user',
    });
  });

  test('under the limit passes', () => {
    expect(decideSpendCap({ ...base, spentUsd: 9.99 })).toEqual({
      allowed: true,
      reason: 'under_limit',
    });
  });

  test('EXACTLY at the limit is refused, not allowed one more', () => {
    const decision = decideSpendCap({ ...base, spentUsd: 10 });
    expect(decision.allowed).toBe(false);
  });

  test('over the limit is refused and reports the numbers back', () => {
    const decision = decideSpendCap({ ...base, spentUsd: 12.5 });
    expect(decision).toEqual({
      allowed: false,
      spentUsd: 12.5,
      limitUsd: 10,
      windowDays: 30,
    });
  });
});

describe('spendWindowStart', () => {
  test('subtracts the window from now', () => {
    const now = new Date('2026-07-28T00:00:00.000Z');
    expect(spendWindowStart(now, 7).toISOString()).toBe('2026-07-21T00:00:00.000Z');
  });

  test('a nonsense window falls back to 30 days rather than to "all time"', () => {
    // A zero or NaN window would make the lower bound `now`, silently measuring
    // spend over an empty interval — a cap that can never fire.
    const now = new Date('2026-07-28T00:00:00.000Z');
    expect(spendWindowStart(now, 0).toISOString()).toBe('2026-06-28T00:00:00.000Z');
    expect(spendWindowStart(now, Number.NaN).toISOString()).toBe('2026-06-28T00:00:00.000Z');
  });
});

describe('spendCapError', () => {
  test('carries a distinct code so a wrapper can tell it from the concurrency cap', () => {
    const err = spendCapError({ allowed: false, spentUsd: 12.5, limitUsd: 10, windowDays: 30 });
    expect(err.status).toBe(429);
    expect(err.body.code).toBe('per_end_user_spend_limit');
    expect(err.body.limit_usd).toBe(10);
    expect(err.body.spent_usd).toBe(12.5);
  });

  test('the message states the window, so "why was I refused" is answerable', () => {
    const err = spendCapError({ allowed: false, spentUsd: 12.5, limitUsd: 10, windowDays: 7 });
    expect(err.body.message).toContain('$12.50');
    expect(err.body.message).toContain('$10.00');
    expect(err.body.message).toContain('7 days');
  });

  test('singularizes a one-day window', () => {
    const err = spendCapError({ allowed: false, spentUsd: 2, limitUsd: 1, windowDays: 1 });
    expect(err.body.message).toContain('1 day (');
  });
});
