import { describe, expect, test } from 'bun:test';

import { testUiTranslator } from '../../test-utils/intl';
import type { PatPolicy } from '@kortix/sdk';
import {
  NEVER_EXPIRES,
  defaultExpiryOption,
  defaultKeyExpiryOption,
  expiresAtIso,
  expiryOptions,
  keyExpiresAt,
  keyExpiryOptions,
} from './api-key-expiry';

function policy(over: Partial<PatPolicy> = {}): PatPolicy {
  return { max_lifetime_days: null, require_expiry: false, idle_revoke_days: null, ...over };
}

describe('expiryOptions', () => {
  test('with no rules set, every preset plus Never', () => {
    expect(expiryOptions(policy(), testUiTranslator).map((o) => o.value)).toEqual([
      NEVER_EXPIRES,
      '1',
      '30',
      '90',
      '365',
    ]);
  });

  test('a missing policy behaves like no rules — the form still works while the query loads', () => {
    expect(expiryOptions(null, testUiTranslator).map((o) => o.value)).toEqual([
      NEVER_EXPIRES,
      '1',
      '30',
      '90',
      '365',
    ]);
    expect(expiryOptions(undefined, testUiTranslator).map((o) => o.value)).toEqual([
      NEVER_EXPIRES,
      '1',
      '30',
      '90',
      '365',
    ]);
  });

  test('require_expiry removes Never', () => {
    const values = expiryOptions(policy({ require_expiry: true }), testUiTranslator).map(
      (o) => o.value,
    );
    expect(values).toEqual(['1', '30', '90', '365']);
  });

  test('a lifetime cap drops the presets beyond it', () => {
    const values = expiryOptions(policy({ max_lifetime_days: 90 }), testUiTranslator).map(
      (o) => o.value,
    );
    expect(values).toEqual([NEVER_EXPIRES, '1', '30', '90']);
  });

  test('a cap between presets keeps the cap and adds the shorter preset', () => {
    const values = expiryOptions(policy({ max_lifetime_days: 7 }), testUiTranslator).map(
      (o) => o.value,
    );
    expect(values).toEqual([NEVER_EXPIRES, '1', '7']);
  });

  test('a cap plus require_expiry leaves only dates within the cap', () => {
    const values = expiryOptions(
      policy({ max_lifetime_days: 7, require_expiry: true }),
      testUiTranslator,
    ).map((o) => o.value);
    expect(values).toEqual(['1', '7']);
  });

  test('a cap alone never forces an expiry — the backend checks the two rules separately', () => {
    expect(expiryOptions(policy({ max_lifetime_days: 30 }), testUiTranslator)[0]?.value).toBe(
      NEVER_EXPIRES,
    );
  });

  test('labels read as time, not as numbers', () => {
    expect(expiryOptions(policy(), testUiTranslator).map((o) => o.label)).toEqual([
      'Never',
      '1 day',
      '30 days',
      '90 days',
      '1 year',
    ]);
  });
});

describe('defaultExpiryOption', () => {
  test('defaults to Never when the workspace allows it', () => {
    expect(defaultExpiryOption(policy(), testUiTranslator)).toBe(NEVER_EXPIRES);
    expect(defaultExpiryOption(policy({ max_lifetime_days: 30 }), testUiTranslator)).toBe(
      NEVER_EXPIRES,
    );
  });

  test('defaults to 90 days once an expiry is required', () => {
    expect(defaultExpiryOption(policy({ require_expiry: true }), testUiTranslator)).toBe('90');
  });

  test('falls back to the longest allowed date when 90 days is over the cap', () => {
    expect(
      defaultExpiryOption(
        policy({ require_expiry: true, max_lifetime_days: 30 }),
        testUiTranslator,
      ),
    ).toBe('30');
    expect(
      defaultExpiryOption(policy({ require_expiry: true, max_lifetime_days: 7 }), testUiTranslator),
    ).toBe('7');
  });
});

describe('expiresAtIso', () => {
  const now = Date.parse('2026-08-12T00:00:00.000Z');

  test('Never sends no date at all', () => {
    expect(expiresAtIso(NEVER_EXPIRES, now)).toBeUndefined();
  });

  test('a day count becomes an instant that many days out', () => {
    expect(expiresAtIso('1', now)).toBe('2026-08-13T00:00:00.000Z');
    expect(expiresAtIso('30', now)).toBe('2026-09-11T00:00:00.000Z');
    expect(expiresAtIso('365', now)).toBe('2027-08-12T00:00:00.000Z');
  });

  test('a nonsense value degrades to no expiry rather than an invalid date', () => {
    expect(expiresAtIso('', now)).toBeUndefined();
    expect(expiresAtIso('-1', now)).toBeUndefined();
    expect(expiresAtIso('abc', now)).toBeUndefined();
  });
});

describe('API key expiry (a key always expires unless the policy allows no expiry)', () => {
  const keyPolicy = (patch: Partial<PatPolicy> = {}): PatPolicy => ({
    max_lifetime_days: null,
    require_expiry: false,
    idle_revoke_days: null,
    ...patch,
  });

  test('no policy rules: every preset up to 365 days, no Never, 90 days preselected', () => {
    expect(keyExpiryOptions(keyPolicy(), testUiTranslator).map((o) => o.value)).toEqual(['1', '30', '90', '365']);
    expect(defaultKeyExpiryOption(keyPolicy(), testUiTranslator)).toBe('90');
    expect(keyExpiryOptions(null, testUiTranslator).map((o) => o.value)).toEqual(['1', '30', '90', '365']);
  });

  test('allow_no_expiry adds Never last; require_expiry removes it again', () => {
    expect(keyExpiryOptions(keyPolicy({ allow_no_expiry: true }), testUiTranslator).map((o) => o.value)).toEqual([
      '1', '30', '90', '365', NEVER_EXPIRES,
    ]);
    expect(
      keyExpiryOptions(keyPolicy({ allow_no_expiry: true, require_expiry: true }), testUiTranslator).map((o) => o.value),
    ).not.toContain(NEVER_EXPIRES);
  });

  test('a policy maximum bounds the presets and the default', () => {
    expect(keyExpiryOptions(keyPolicy({ max_lifetime_days: 30 }), testUiTranslator).map((o) => o.value)).toEqual(['1', '30']);
    expect(defaultKeyExpiryOption(keyPolicy({ max_lifetime_days: 30 }), testUiTranslator)).toBe('30');
    expect(keyExpiryOptions(keyPolicy({ max_lifetime_days: 7 }), testUiTranslator).map((o) => o.value)).toEqual(['1', '7']);
  });

  test('Never sends an explicit null; a day count sends an instant', () => {
    const now = Date.parse('2026-08-12T00:00:00.000Z');
    expect(keyExpiresAt(NEVER_EXPIRES, now)).toBeNull();
    expect(keyExpiresAt('30', now)).toBe('2026-09-11T00:00:00.000Z');
  });
});
