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

// Same-origin deployments (BACKEND_URL is a relative proxy path like '/v1'):
// the page origin IS the public origin, so the Tenant URL must resolve
// absolute against it — an IdP can't call a relative path.
describe('buildScimBaseUrl page-origin fallback', () => {
  test('relative backend + page origin → absolute against the page', () => {
    expect(buildScimBaseUrl('acc-1', '/v1', 'https://kortix.example.com')).toBe(
      'https://kortix.example.com/scim/v2/accounts/acc-1',
    );
  });

  test('absolute backend still wins over the page origin', () => {
    expect(buildScimBaseUrl('acc-1', 'https://api.kortix.com/v1', 'https://web.other.com')).toBe(
      'https://api.kortix.com/scim/v2/accounts/acc-1',
    );
  });

  test('trailing slash on the page origin is normalized', () => {
    expect(buildScimBaseUrl('acc-1', '/v1', 'https://kortix.example.com/')).toBe(
      'https://kortix.example.com/scim/v2/accounts/acc-1',
    );
  });

  test('no backend, no origin (SSR) → relative path unchanged', () => {
    expect(buildScimBaseUrl('acc-1', '/v1', null)).toBe('/scim/v2/accounts/acc-1');
  });
});
