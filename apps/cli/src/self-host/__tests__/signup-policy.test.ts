import { describe, expect, test } from 'bun:test';

import { signupModeOf } from '../signup-policy.ts';

describe('signupModeOf', () => {
  const domain = { KORTIX_DOMAIN: 'kortix.example.com' };

  test('a public instance that confirms nothing is invite-only', () => {
    expect(signupModeOf({ ...domain, ENABLE_EMAIL_AUTOCONFIRM: 'true' })).toBe('invite');
    expect(signupModeOf(domain)).toBe('invite');
  });

  test('a public instance that confirms email addresses, and a laptop instance, are open', () => {
    expect(signupModeOf({ ...domain, ENABLE_EMAIL_AUTOCONFIRM: 'false' })).toBe('open');
    expect(signupModeOf({})).toBe('open');
  });

  test('an explicit mode wins; an unknown value falls back to the default', () => {
    expect(signupModeOf({ ...domain, KORTIX_SIGNUP_MODE: 'open' })).toBe('open');
    expect(signupModeOf({ KORTIX_SIGNUP_MODE: 'closed' })).toBe('closed');
    expect(signupModeOf({ ...domain, KORTIX_SIGNUP_MODE: 'everyone' })).toBe('invite');
  });
});
