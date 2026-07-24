import { describe, expect, test } from 'bun:test';
import { isValidCompanyDomain, normalizeCompanyDomain } from './company-domain';

describe('normalizeCompanyDomain', () => {
  const accepted: Array<[string, string]> = [
    ['example.com', 'example.com'],
    ['Example.COM', 'example.com'],
    ['  example.com  ', 'example.com'],
    ['www.example.com', 'example.com'],
    ['https://example.com', 'example.com'],
    ['http://example.com', 'example.com'],
    ['https://www.example.com/pricing?utm_source=x#top', 'example.com'],
    ['example.com.', 'example.com'],
    ['sub.example.com', 'sub.example.com'],
    ['my-company.io', 'my-company.io'],
    ['example.co.uk', 'example.co.uk'],
  ];

  for (const [input, expected] of accepted) {
    test(`accepts ${JSON.stringify(input)}`, () => {
      expect(normalizeCompanyDomain(input)).toBe(expected);
    });
  }

  const rejected = [
    '',
    '   ',
    'localhost',
    'example',
    '127.0.0.1',
    'https://127.0.0.1',
    '169.254.169.254',
    'ftp://example.com',
    'https://user:pass@example.com',
    'https://example.com:8443',
    'two words.com',
    '-example.com',
    'example-.com',
    'example..com',
    'example.c',
    'example.123',
  ];

  for (const input of rejected) {
    test(`rejects ${JSON.stringify(input)}`, () => {
      expect(normalizeCompanyDomain(input)).toBeNull();
    });
  }

  test('is idempotent over its own output', () => {
    const once = normalizeCompanyDomain('https://WWW.Example.com/path');
    expect(normalizeCompanyDomain(once!)).toBe(once);
  });

  test('agrees with the boolean helper', () => {
    expect(isValidCompanyDomain('example.com')).toBe(true);
    expect(isValidCompanyDomain('localhost')).toBe(false);
  });
});
