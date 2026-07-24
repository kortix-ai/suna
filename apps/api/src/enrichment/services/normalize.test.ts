import { describe, expect, test } from 'bun:test';
import { EnrichmentError } from '../errors';
import { canonicalOrigin, idempotencyKey, normalizeDomain } from './normalize';

describe('normalizeDomain', () => {
  const accepted: Array<[string, string]> = [
    ['example.com', 'example.com'],
    ['Example.COM', 'example.com'],
    ['  example.com  ', 'example.com'],
    ['www.example.com', 'example.com'],
    ['WWW.Example.com', 'example.com'],
    ['https://example.com', 'example.com'],
    ['http://example.com', 'example.com'],
    ['https://www.example.com/pricing?utm_source=x#top', 'example.com'],
    ['example.com.', 'example.com'],
    ['https://example.com:443/', 'example.com'],
    ['sub.example.com', 'sub.example.com'],
    ['deep.sub.example.co.uk', 'deep.sub.example.co.uk'],
    ['my-company.io', 'my-company.io'],
    ['wwwx.example.com', 'wwwx.example.com'],
  ];

  for (const [input, expected] of accepted) {
    test(`accepts ${JSON.stringify(input)} as ${expected}`, () => {
      expect(normalizeDomain(input)).toBe(expected);
    });
  }

  const rejected: Array<[string, string]> = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['localhost', 'single label'],
    ['example', 'single label'],
    ['127.0.0.1', 'ipv4 literal'],
    ['https://127.0.0.1', 'ipv4 literal with scheme'],
    ['169.254.169.254', 'metadata ip'],
    ['[::1]', 'ipv6 literal'],
    ['https://[::1]/', 'ipv6 literal with scheme'],
    ['999.999.999.999', 'numeric tld'],
    ['ftp://example.com', 'unsupported scheme'],
    ['file:///etc/passwd', 'unsupported scheme'],
    ['https://user:pass@example.com', 'embedded credentials'],
    ['https://example.com:8443', 'non-standard port'],
    ['exa mple.com', 'whitespace'],
    ['-example.com', 'label starts with hyphen'],
    ['example-.com', 'label ends with hyphen'],
    ['example..com', 'empty label'],
    ['example.c', 'one-character tld'],
    ['example.123', 'digit tld'],
  ];

  for (const [input, reason] of rejected) {
    test(`rejects ${JSON.stringify(input)} (${reason})`, () => {
      expect(() => normalizeDomain(input)).toThrow(EnrichmentError);
    });
  }

  test('rejections carry the invalid_domain code', () => {
    try {
      normalizeDomain('localhost');
      throw new Error('expected a rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(EnrichmentError);
      expect((err as EnrichmentError).code).toBe('invalid_domain');
    }
  });

  test('rejects a host longer than the dns limit', () => {
    const long = `${Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.')}.com`;
    expect(() => normalizeDomain(long)).toThrow(EnrichmentError);
  });

  test('rejects a label longer than 63 characters', () => {
    expect(() => normalizeDomain(`${'a'.repeat(64)}.com`)).toThrow(EnrichmentError);
  });

  test('encodes internationalized domains as punycode', () => {
    expect(normalizeDomain('münchen.de')).toBe('xn--mnchen-3ya.de');
  });

  test('is idempotent over its own output', () => {
    const once = normalizeDomain('https://WWW.Example.com/path');
    expect(normalizeDomain(once)).toBe(once);
  });
});

describe('canonicalOrigin', () => {
  test('always forces https', () => {
    expect(canonicalOrigin('example.com')).toBe('https://example.com');
  });
});

describe('idempotencyKey', () => {
  test('combines project and domain', () => {
    expect(idempotencyKey('p1', 'example.com')).toBe('p1:example.com');
  });

  test('separates different projects for the same domain', () => {
    expect(idempotencyKey('p1', 'example.com')).not.toBe(idempotencyKey('p2', 'example.com'));
  });
});
