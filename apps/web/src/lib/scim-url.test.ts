import { describe, expect, test } from 'bun:test';
import { buildScimBaseUrl, isAbsoluteHttpUrl } from './scim-url';

describe('buildScimBaseUrl', () => {
  test('prepends the API origin when the backend URL is absolute', () => {
    expect(buildScimBaseUrl('acc-1', 'https://api.kortix.com')).toBe(
      'https://api.kortix.com/scim/v2/accounts/acc-1',
    );
  });

  test('uses only the ORIGIN, dropping any API path prefix like /v1', () => {
    expect(buildScimBaseUrl('acc-1', 'https://api.kortix.com/v1')).toBe(
      'https://api.kortix.com/scim/v2/accounts/acc-1',
    );
  });

  test('falls back to a relative path for a root-relative proxy backend', () => {
    expect(buildScimBaseUrl('acc-1', '/v1')).toBe('/scim/v2/accounts/acc-1');
  });

  test('falls back to a relative path when the backend URL is missing', () => {
    expect(buildScimBaseUrl('acc-1', undefined)).toBe('/scim/v2/accounts/acc-1');
    expect(buildScimBaseUrl('acc-1', null)).toBe('/scim/v2/accounts/acc-1');
  });

  test('falls back to a relative path when the backend URL is malformed', () => {
    expect(buildScimBaseUrl('acc-1', 'http://[not-a-url')).toBe('/scim/v2/accounts/acc-1');
  });
});

describe('isAbsoluteHttpUrl', () => {
  test('true for http(s) URLs, false for relative paths', () => {
    expect(isAbsoluteHttpUrl('https://api.kortix.com/scim/v2/accounts/x')).toBe(true);
    expect(isAbsoluteHttpUrl('/scim/v2/accounts/x')).toBe(false);
  });
});
