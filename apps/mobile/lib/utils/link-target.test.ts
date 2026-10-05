import { describe, expect, test } from 'bun:test';

import { httpHost, isKortixHost, linkTarget } from './link-target';

describe('linkTarget', () => {
  test('opens kortix.com and its subdomains in the in-app browser', () => {
    expect(linkTarget('https://kortix.com')).toBe('in-app');
    expect(linkTarget('https://kortix.com/pricing?x=1#y')).toBe('in-app');
    expect(linkTarget('https://www.kortix.com/')).toBe('in-app');
    expect(linkTarget('https://docs.kortix.com/sdk')).toBe('in-app');
    expect(linkTarget('https://support.kortix.com')).toBe('in-app');
    expect(linkTarget('https://my-site.pages.kortix.com/index.html')).toBe('in-app');
    expect(linkTarget('http://staging.kortix.com/share/abc')).toBe('in-app');
    expect(linkTarget('HTTPS://DOCS.KORTIX.COM/')).toBe('in-app');
    expect(linkTarget('  https://kortix.com/legal  ')).toBe('in-app');
  });

  test('opens third-party links in the system browser', () => {
    expect(linkTarget('https://github.com/acme/repo')).toBe('system');
    expect(linkTarget('https://example.com')).toBe('system');
    expect(linkTarget('http://localhost:3000/x')).toBe('system');
  });

  test('never treats a look-alike host as Kortix', () => {
    expect(linkTarget('https://evilkortix.com')).toBe('system');
    expect(linkTarget('https://kortix.com.evil.example/x')).toBe('system');
    expect(linkTarget('https://kortix.co')).toBe('system');
    // Userinfo is not the host: this URL goes to evil.example.
    expect(linkTarget('https://kortix.com@evil.example/x')).toBe('system');
    expect(linkTarget('https://user:pw@docs.kortix.com/x')).toBe('in-app');
  });

  test('returns null for non-web links and malformed input', () => {
    expect(linkTarget('mailto:support@kortix.com')).toBeNull();
    expect(linkTarget('tel:+15550100')).toBeNull();
    expect(linkTarget('kortix://share/abc')).toBeNull();
    expect(linkTarget('ftp://kortix.com')).toBeNull();
    expect(linkTarget('kortix.com')).toBeNull();
    expect(linkTarget('https://')).toBeNull();
    expect(linkTarget('')).toBeNull();
  });
});

describe('httpHost', () => {
  test('strips userinfo, port, and a trailing dot, and lowercases', () => {
    expect(httpHost('https://User@Docs.Kortix.com:8443/a')).toBe('docs.kortix.com');
    expect(httpHost('https://kortix.com./a')).toBe('kortix.com');
    expect(httpHost('http://127.0.0.1:8008/v1')).toBe('127.0.0.1');
  });
});

describe('isKortixHost', () => {
  test('matches the apex and subdomains only', () => {
    expect(isKortixHost('kortix.com')).toBe(true);
    expect(isKortixHost('a.b.kortix.com')).toBe(true);
    expect(isKortixHost('kortix.com.')).toBe(true);
    expect(isKortixHost('notkortix.com')).toBe(false);
    expect(isKortixHost('kortix.com.au')).toBe(false);
  });
});
