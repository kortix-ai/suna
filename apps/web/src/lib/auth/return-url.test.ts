import { describe, expect, test } from 'bun:test';

import { isInviteReturnUrl, sanitizeAuthReturnUrl } from './return-url';

describe('sanitizeAuthReturnUrl', () => {
  test('preserves an invite URL verbatim (must survive to reach the dialog)', () => {
    expect(sanitizeAuthReturnUrl('/invites/abc-123')).toBe('/invites/abc-123');
  });

  test('falls back to /projects when no value is given', () => {
    expect(sanitizeAuthReturnUrl(undefined)).toBe('/projects');
    expect(sanitizeAuthReturnUrl(null)).toBe('/projects');
  });

  test('rejects an absolute/off-origin URL', () => {
    expect(sanitizeAuthReturnUrl('https://evil.example.com')).toBe('/projects');
    expect(sanitizeAuthReturnUrl('//evil.example.com')).toBe('/projects');
  });
});

describe('isInviteReturnUrl', () => {
  test('true for an invite acceptance path', () => {
    expect(isInviteReturnUrl('/invites/abc-123')).toBe(true);
    expect(isInviteReturnUrl('/invites/abc-123?x=1')).toBe(true);
  });

  test('false for non-invite destinations', () => {
    expect(isInviteReturnUrl('/projects')).toBe(false);
    expect(isInviteReturnUrl('/accounts')).toBe(false);
    // Must be the /invites/ segment, not just a prefix match.
    expect(isInviteReturnUrl('/invitesomething')).toBe(false);
    expect(isInviteReturnUrl('/invites')).toBe(false);
  });

  test('false for nullish input', () => {
    expect(isInviteReturnUrl(null)).toBe(false);
    expect(isInviteReturnUrl(undefined)).toBe(false);
  });

  test('the sanitized invite URL is recognized end-to-end', () => {
    expect(isInviteReturnUrl(sanitizeAuthReturnUrl('/invites/xyz'))).toBe(true);
  });
});
