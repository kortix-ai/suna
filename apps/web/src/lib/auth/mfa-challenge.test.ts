import { describe, expect, test } from 'bun:test';

import { MFA_PENDING_COOKIE, hasVerifiedTotpFactor, mfaChallengePath } from './mfa-challenge';

/**
 * The predicate every TOTP gate keys on. A verified authenticator-app factor
 * holds the session at the challenge; an unverified enrollment, a phone
 * factor, or no factor at all must never gate — otherwise every account
 * without TOTP would be locked out of the app.
 */
describe('hasVerifiedTotpFactor', () => {
  test('a verified TOTP factor gates', () => {
    expect(hasVerifiedTotpFactor({ factors: [{ factor_type: 'totp', status: 'verified' }] })).toBe(
      true,
    );
  });

  test('an unverified enrollment does not gate', () => {
    expect(
      hasVerifiedTotpFactor({ factors: [{ factor_type: 'totp', status: 'unverified' }] }),
    ).toBe(false);
  });

  test('a phone factor does not gate (TOTP scope)', () => {
    expect(hasVerifiedTotpFactor({ factors: [{ factor_type: 'phone', status: 'verified' }] })).toBe(
      false,
    );
  });

  test('no factors, or a user object without the field, does not gate', () => {
    expect(hasVerifiedTotpFactor({ factors: [] })).toBe(false);
    expect(hasVerifiedTotpFactor({})).toBe(false);
    expect(hasVerifiedTotpFactor(null)).toBe(false);
    expect(hasVerifiedTotpFactor(undefined)).toBe(false);
  });
});

describe('mfaChallengePath', () => {
  test('the destination rides along as an encoded returnUrl', () => {
    expect(mfaChallengePath('/projects/abc?tab=a')).toBe(
      `/auth/mfa?returnUrl=${encodeURIComponent('/projects/abc?tab=a')}`,
    );
  });

  test('the pending cookie name is the one the middleware and the page share', () => {
    expect(MFA_PENDING_COOKIE).toBe('kortix-mfa-pending');
  });
});
