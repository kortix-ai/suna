import { describe, expect, test } from 'bun:test';

import {
  isSsoIdentityMismatch,
  normalizeAuthEmail,
  readSsoExpectedEmail,
  SSO_EXPECTED_EMAIL_COOKIE,
  SSO_EXPECTED_EMAIL_MAX_AGE,
  SSO_IDENTITY_MISMATCH,
  SSO_IDENTITY_PARAM,
} from './sso-identity';

describe('normalizeAuthEmail', () => {
  test('trims and lowercases', () => {
    expect(normalizeAuthEmail('  Admin@Example.COM  ')).toBe('admin@example.com');
  });

  test('non-strings and blanks normalize to empty', () => {
    for (const value of [null, undefined, '', '   ']) {
      expect(normalizeAuthEmail(value as string | null | undefined)).toBe('');
    }
  });

  test('an absurdly long value is discarded rather than compared', () => {
    expect(normalizeAuthEmail(`${'a'.repeat(320)}@example.com`)).toBe('');
  });
});

describe('isSsoIdentityMismatch', () => {
  test('the same address in different case or padding is not a mismatch', () => {
    expect(isSsoIdentityMismatch('admin@example.com', 'admin@example.com')).toBe(false);
    expect(isSsoIdentityMismatch('Admin@Example.com', 'admin@example.com')).toBe(false);
    expect(isSsoIdentityMismatch(' admin@example.com ', 'admin@example.com')).toBe(false);
  });

  test('a different address is a mismatch — the incident this exists for', () => {
    // The admin typed their own address; the IdP reused an existing browser
    // session and answered with a colleague's.
    expect(isSsoIdentityMismatch('admin@example.com', 'someone.else@example.com')).toBe(true);
  });

  test('a different address on the same domain still counts', () => {
    expect(isSsoIdentityMismatch('a@corp.com', 'b@corp.com')).toBe(true);
  });

  test('absence is never a mismatch, in either direction', () => {
    // A password login or magic link has nothing to compare. Reporting those as
    // mismatches would train users to dismiss the notice.
    expect(isSsoIdentityMismatch(null, 'admin@example.com')).toBe(false);
    expect(isSsoIdentityMismatch('admin@example.com', null)).toBe(false);
    expect(isSsoIdentityMismatch(undefined, undefined)).toBe(false);
    expect(isSsoIdentityMismatch('', '')).toBe(false);
  });
});

describe('readSsoExpectedEmail', () => {
  test('decodes what rememberSsoExpectedEmail wrote', () => {
    expect(readSsoExpectedEmail(encodeURIComponent('admin+tag@example.com'))).toBe(
      'admin+tag@example.com',
    );
  });

  test('a malformed percent-escape reads as absent, not as a mismatch', () => {
    // '%E0%A4%A' is an invalid sequence; decodeURIComponent throws on it.
    expect(readSsoExpectedEmail('%E0%A4%A')).toBe('');
    expect(isSsoIdentityMismatch(readSsoExpectedEmail('%E0%A4%A'), 'admin@example.com')).toBe(
      false,
    );
  });

  test('missing or empty reads as absent', () => {
    expect(readSsoExpectedEmail(null)).toBe('');
    expect(readSsoExpectedEmail(undefined)).toBe('');
    expect(readSsoExpectedEmail('')).toBe('');
  });
});

describe('the constants the callback and the notice agree on', () => {
  test('the marker carries no address', () => {
    // Keeping the signed-in address out of the URL keeps it out of history and
    // out of the Referer of anything the landing page requests.
    expect(SSO_IDENTITY_PARAM).toBe('sso_identity');
    expect(SSO_IDENTITY_MISMATCH).toBe('mismatch');
  });

  test('the cookie is short-lived', () => {
    expect(SSO_EXPECTED_EMAIL_COOKIE).toBe('kortix_sso_expected_email');
    expect(SSO_EXPECTED_EMAIL_MAX_AGE).toBeLessThanOrEqual(60 * 30);
    expect(SSO_EXPECTED_EMAIL_MAX_AGE).toBeGreaterThanOrEqual(60 * 5);
  });
});
