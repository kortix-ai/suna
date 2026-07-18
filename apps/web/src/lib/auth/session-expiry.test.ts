import { describe, expect, test } from 'bun:test';

import { isSessionExpired } from './session-expiry';

describe('isSessionExpired', () => {
  test('false for a session expiring in the future', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(isSessionExpired({ expires_at: future })).toBe(false);
  });

  test('true for a session whose expires_at is already in the past', () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(isSessionExpired({ expires_at: past })).toBe(true);
  });

  test('true for a session expiring this instant (boundary)', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isSessionExpired({ expires_at: now })).toBe(true);
  });

  test('false for null/undefined session — nothing to prove expired locally', () => {
    expect(isSessionExpired(null)).toBe(false);
    expect(isSessionExpired(undefined)).toBe(false);
  });

  test('false when expires_at is missing or not a number', () => {
    expect(isSessionExpired({})).toBe(false);
    expect(isSessionExpired({ expires_at: null })).toBe(false);
    expect(isSessionExpired({ expires_at: '123' as unknown as number })).toBe(false);
  });
});
