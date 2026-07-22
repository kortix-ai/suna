import { describe, expect, test } from 'bun:test';

import { secureRemoteBase } from '../api/client.ts';

// Regression: a remote http:// API base (e.g. the built-in kortix-internal-dev
// host) 308-redirects to https, and fetch drops the Authorization header on the
// scheme change — so token validation silently 401s as "Token rejected by the
// API" even though the browser login succeeded. Remote http must be upgraded to
// https before we send credentials; localhost/self-host stay plain http.
describe('secureRemoteBase', () => {
  test('upgrades remote http:// to https://', () => {
    expect(secureRemoteBase('http://dev-api.kortix.com')).toBe('https://dev-api.kortix.com');
    expect(secureRemoteBase('http://api.kortix.com')).toBe('https://api.kortix.com');
    expect(secureRemoteBase('http://api.essentia.kortix.cloud')).toBe('https://api.essentia.kortix.cloud');
  });

  test('preserves a path/port when upgrading', () => {
    expect(secureRemoteBase('http://dev-api.kortix.com/v1')).toBe('https://dev-api.kortix.com/v1');
    expect(secureRemoteBase('http://example.com:8443')).toBe('https://example.com:8443');
  });

  test('leaves https:// untouched', () => {
    expect(secureRemoteBase('https://dev-api.kortix.com')).toBe('https://dev-api.kortix.com');
  });

  test('leaves localhost / self-host on http', () => {
    expect(secureRemoteBase('http://localhost:8008')).toBe('http://localhost:8008');
    expect(secureRemoteBase('http://127.0.0.1:13738')).toBe('http://127.0.0.1:13738');
    expect(secureRemoteBase('http://0.0.0.0:3000')).toBe('http://0.0.0.0:3000');
    expect(secureRemoteBase('http://foo.localhost:8008')).toBe('http://foo.localhost:8008');
  });

  test('leaves an unparseable base as-is', () => {
    expect(secureRemoteBase('not a url')).toBe('not a url');
  });
});
