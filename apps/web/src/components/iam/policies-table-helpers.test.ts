import { describe, expect, test } from 'bun:test';
import {
  formatExpiryShort,
  isPlausibleCidr,
  summariseConditions,
  toLocalInput,
} from './policies-table-helpers';

describe('summariseConditions', () => {
  test('empty / undefined → no badges', () => {
    expect(summariseConditions(undefined)).toEqual([]);
    expect(summariseConditions({})).toEqual([]);
  });

  test('single CIDR → "IP allowlist"', () => {
    expect(summariseConditions({ ip_cidrs: ['10.0.0.0/8'] })).toEqual(['IP allowlist']);
  });

  test('multiple CIDRs include the count', () => {
    expect(summariseConditions({ ip_cidrs: ['10.0.0.0/8', '11.0.0.0/8'] })).toEqual([
      'IP allowlist (2)',
    ]);
  });

  test('require_mfa appears as its own badge', () => {
    expect(summariseConditions({ require_mfa: true })).toEqual(['MFA required']);
  });

  test('both conditions return both badges', () => {
    expect(
      summariseConditions({ ip_cidrs: ['10.0.0.0/8'], require_mfa: true }),
    ).toEqual(['IP allowlist', 'MFA required']);
  });
});

describe('isPlausibleCidr', () => {
  test('valid IPv4 forms', () => {
    expect(isPlausibleCidr('10.0.0.1')).toBe(true);
    expect(isPlausibleCidr('10.0.0.0/8')).toBe(true);
    expect(isPlausibleCidr('255.255.255.255')).toBe(true);
  });

  test('valid IPv6 forms', () => {
    expect(isPlausibleCidr('::1')).toBe(true);
    expect(isPlausibleCidr('2001:db8::/32')).toBe(true);
    expect(isPlausibleCidr('fe80::1')).toBe(true);
  });

  test('rejects garbage', () => {
    expect(isPlausibleCidr('')).toBe(false);
    expect(isPlausibleCidr('not-an-ip')).toBe(false);
    expect(isPlausibleCidr('999.0.0.0')).toBe(false);
    expect(isPlausibleCidr('10.0.0.0/99')).toBe(false);
  });
});

describe('toLocalInput', () => {
  test('returns YYYY-MM-DDTHH:MM for a valid ISO', () => {
    // Build an ISO at midday local — the helper subtracts the local
    // offset, so we expect the output to match the local clock.
    const sample = new Date(2026, 4, 22, 12, 30).toISOString();
    const local = toLocalInput(sample);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  test('invalid ISO → empty string', () => {
    expect(toLocalInput('not-a-date')).toBe('');
  });
});

describe('formatExpiryShort', () => {
  test('< 1 minute → minutes (clamped to 1)', () => {
    const iso = new Date(Date.now() + 30_000).toISOString();
    expect(formatExpiryShort(iso)).toBe('1m');
  });

  test('hours window', () => {
    const iso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    expect(formatExpiryShort(iso)).toBe('2h');
  });

  test('days window', () => {
    const iso = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatExpiryShort(iso)).toBe('3d');
  });

  test('past timestamp → "expired"', () => {
    const iso = new Date(Date.now() - 1000).toISOString();
    expect(formatExpiryShort(iso)).toBe('expired');
  });
});
