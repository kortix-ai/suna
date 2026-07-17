import { describe, expect, test } from 'bun:test';

import { isInviteReturnUrl, resolveAuthRedirectBaseUrl, sanitizeAuthReturnUrl } from './return-url';

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

describe('resolveAuthRedirectBaseUrl', () => {
  test('prefers the request origin in the normal case (local dev + cloud)', () => {
    expect(resolveAuthRedirectBaseUrl('http://localhost:3000', 'https://staging.example.com')).toBe(
      'http://localhost:3000',
    );
    expect(resolveAuthRedirectBaseUrl('https://kortix.com', 'https://kortix.com')).toBe('https://kortix.com');
  });

  test('leaves loopback origins as-is so local dev stays on localhost', () => {
    expect(resolveAuthRedirectBaseUrl('http://localhost:3000', undefined)).toBe('http://localhost:3000');
    expect(resolveAuthRedirectBaseUrl('http://127.0.0.1:3000', 'https://app.example.com')).toBe(
      'http://127.0.0.1:3000',
    );
  });

  test('falls back to APP_URL when the origin is a 0.0.0.0 wildcard bind (self-host behind proxy)', () => {
    // The exact live symptom: SSO on self-host landing on https://0.0.0.0:3000.
    expect(resolveAuthRedirectBaseUrl('https://0.0.0.0:3000', 'https://essentia.kortix.cloud')).toBe(
      'https://essentia.kortix.cloud',
    );
    expect(resolveAuthRedirectBaseUrl('http://0.0.0.0:3000', 'https://essentia.kortix.cloud/')).toBe(
      'https://essentia.kortix.cloud',
    );
    expect(resolveAuthRedirectBaseUrl('https://[::]:3000', 'https://essentia.kortix.cloud')).toBe(
      'https://essentia.kortix.cloud',
    );
  });

  test('keeps the wildcard origin only if no APP_URL is configured (nothing better to use)', () => {
    expect(resolveAuthRedirectBaseUrl('https://0.0.0.0:3000', undefined)).toBe('https://0.0.0.0:3000');
  });

  test('final fallback when everything is empty', () => {
    expect(resolveAuthRedirectBaseUrl('', undefined)).toBe('http://localhost:3000');
    expect(resolveAuthRedirectBaseUrl(null, 'https://app.example.com/')).toBe('https://app.example.com');
  });
});
