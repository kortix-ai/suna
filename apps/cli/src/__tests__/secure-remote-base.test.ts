import { describe, expect, test } from 'bun:test';

import { secureRemoteBase } from '../api/client.ts';

// Regression: a remote http:// API base (e.g. the built-in kortix-internal-dev
// host) 308-redirects to https, and fetch drops the Authorization header on the
// scheme change — so token validation silently 401s as "Token rejected by the
// API" even though the browser login succeeded. Remote http must be upgraded to
// https before we send credentials; localhost/self-host stay plain http.
describe('secureRemoteBase', () => {
  test('upgrades public http hosts to https', () => {
    for (const [base, expected] of [
      ['http://dev-api.kortix.com', 'https://dev-api.kortix.com'],
      ['http://api.kortix.com', 'https://api.kortix.com'],
      ['http://api.essentia.kortix.cloud', 'https://api.essentia.kortix.cloud'],
      ['http://example.com:8443/v1', 'https://example.com:8443/v1'],
      ['http://11.0.0.1:8000', 'https://11.0.0.1:8000'],
      ['http://172.32.0.1:8000', 'https://172.32.0.1:8000'],
      ['http://192.169.1.1:8000', 'https://192.169.1.1:8000'],
      ['http://[2606:4700:4700::1111]:8000', 'https://[2606:4700:4700::1111]:8000'],
      ['http://[::ffff:8.8.8.8]:8000', 'https://[::ffff:808:808]:8000'],
    ]) {
      expect(secureRemoteBase(base)).toBe(expected);
    }
  });

  test('leaves https and non-URLs unchanged', () => {
    expect(secureRemoteBase('https://dev-api.kortix.com')).toBe('https://dev-api.kortix.com');
    expect(secureRemoteBase('not a url')).toBe('not a url');
  });

  test('leaves loopback and unspecified hosts on http', () => {
    for (const base of [
      'http://localhost:8008',
      'http://foo.localhost:8008',
      'http://127.0.0.1:13738',
      'http://127.20.30.40:13738',
      'http://0.0.0.0:3000',
      'http://[::]:3000',
      'http://[::1]:3000',
    ]) {
      expect(secureRemoteBase(base)).toBe(base);
    }
  });

  test('leaves self-host network names and private IPv4 hosts on http', () => {
    for (const base of [
      'http://kortix-api:8000',
      'http://api:8000',
      'http://10.2.0.7:8000',
      'http://172.16.4.9:8000',
      'http://172.31.255.255:8000',
      'http://192.168.1.50:8000',
      'http://169.254.10.1:8000',
      'http://100.64.0.1:8000',
      'http://100.127.255.255:8000',
      'http://kortix.internal:8000',
      'http://kortix.internal.:8000',
      'http://box.local:8000',
      'http://nas.lan:8000',
      'http://host.home.arpa:8000',
    ]) {
      expect(secureRemoteBase(base)).toBe(base);
    }
  });

  test('leaves private IPv6 hosts on http without treating public IPv6 as a DNS label', () => {
    for (const base of [
      'http://[fc00::1]:8000',
      'http://[fd12:3456::1]:8000',
      'http://[fe80::1]:8000',
      'http://[febf::1]:8000',
      'http://[::ffff:192.168.1.50]:8000',
    ]) {
      expect(secureRemoteBase(base)).toBe(base);
    }
  });
});
