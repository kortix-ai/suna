import { describe, expect, test } from 'bun:test';

import type { PatPolicy } from '@/lib/iam-client';
import { NEVER_EXPIRES, defaultExpiryOption, expiresAtIso, expiryOptions } from './api-key-expiry';

function policy(over: Partial<PatPolicy> = {}): PatPolicy {
  return { max_lifetime_days: null, require_expiry: false, idle_revoke_days: null, ...over };
}

describe('expiryOptions', () => {
  test('with no rules set, every preset plus Never', () => {
    expect(expiryOptions(policy()).map((o) => o.value)).toEqual([NEVER_EXPIRES, '30', '90', '365']);
  });

  test('a missing policy behaves like no rules — the form still works while the query loads', () => {
    expect(expiryOptions(null).map((o) => o.value)).toEqual([NEVER_EXPIRES, '30', '90', '365']);
    expect(expiryOptions(undefined).map((o) => o.value)).toEqual([
      NEVER_EXPIRES,
      '30',
      '90',
      '365',
    ]);
  });

  test('require_expiry removes Never', () => {
    const values = expiryOptions(policy({ require_expiry: true })).map((o) => o.value);
    expect(values).toEqual(['30', '90', '365']);
  });

  test('a lifetime cap drops the presets beyond it', () => {
    const values = expiryOptions(policy({ max_lifetime_days: 90 })).map((o) => o.value);
    expect(values).toEqual([NEVER_EXPIRES, '30', '90']);
  });

  test('a cap shorter than every preset becomes the only dated offer', () => {
    const values = expiryOptions(policy({ max_lifetime_days: 7 })).map((o) => o.value);
    expect(values).toEqual([NEVER_EXPIRES, '7']);
  });

  test('a cap plus require_expiry leaves only dates within the cap', () => {
    const values = expiryOptions(policy({ max_lifetime_days: 7, require_expiry: true })).map(
      (o) => o.value,
    );
    expect(values).toEqual(['7']);
  });

  test('a cap alone never forces an expiry — the backend checks the two rules separately', () => {
    expect(expiryOptions(policy({ max_lifetime_days: 30 }))[0]?.value).toBe(NEVER_EXPIRES);
  });

  test('labels read as time, not as numbers', () => {
    expect(expiryOptions(policy()).map((o) => o.label)).toEqual([
      'Never',
      '30 days',
      '90 days',
      '1 year',
    ]);
  });
});

describe('defaultExpiryOption', () => {
  test('defaults to Never when the workspace allows it', () => {
    expect(defaultExpiryOption(policy())).toBe(NEVER_EXPIRES);
    expect(defaultExpiryOption(policy({ max_lifetime_days: 30 }))).toBe(NEVER_EXPIRES);
  });

  test('defaults to 90 days once an expiry is required', () => {
    expect(defaultExpiryOption(policy({ require_expiry: true }))).toBe('90');
  });

  test('falls back to the longest allowed date when 90 days is over the cap', () => {
    expect(defaultExpiryOption(policy({ require_expiry: true, max_lifetime_days: 30 }))).toBe('30');
    expect(defaultExpiryOption(policy({ require_expiry: true, max_lifetime_days: 7 }))).toBe('7');
  });
});

describe('expiresAtIso', () => {
  const now = Date.parse('2026-08-12T00:00:00.000Z');

  test('Never sends no date at all', () => {
    expect(expiresAtIso(NEVER_EXPIRES, now)).toBeUndefined();
  });

  test('a day count becomes an instant that many days out', () => {
    expect(expiresAtIso('30', now)).toBe('2026-09-11T00:00:00.000Z');
    expect(expiresAtIso('365', now)).toBe('2027-08-12T00:00:00.000Z');
  });

  test('a nonsense value degrades to no expiry rather than an invalid date', () => {
    expect(expiresAtIso('', now)).toBeUndefined();
    expect(expiresAtIso('-1', now)).toBeUndefined();
    expect(expiresAtIso('abc', now)).toBeUndefined();
  });
});
