import { describe, expect, test } from 'bun:test';

import { SIGN_OUT_DESTINATION, signOutDestination } from './perform-sign-out';

// KRTX-1731: "Sign out and continue" on an invite addressed to another account
// returns to the invite after the next sign-in. The return path is a
// same-origin path or nothing: sign-out is never an open redirect.
describe('signOutDestination', () => {
  test('no return path: the sign-in page', () => {
    expect(signOutDestination()).toBe(SIGN_OUT_DESTINATION);
  });

  test('a same-origin path comes back after the next sign-in', () => {
    expect(signOutDestination('/invites/abc')).toBe(`${SIGN_OUT_DESTINATION}?returnUrl=%2Finvites%2Fabc`);
  });

  test('an absolute, protocol-relative or backslash URL is dropped', () => {
    for (const evil of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'invites/abc']) {
      expect(signOutDestination(evil)).toBe(SIGN_OUT_DESTINATION);
    }
  });
});
