import { describe, expect, test } from 'bun:test';
import { hostOf, newUrls, pendingTitle, urlsIn } from './outside';

describe('outside content is a URL the page does not hold', () => {
  test('http(s) URLs are found and normalized; trailing punctuation is not part of one', () => {
    expect(urlsIn('See https://Example.com/pricing. Also http://acme.test/a?b=1, and ftp://x.test')).toEqual([
      'https://example.com/pricing',
      'http://acme.test/a?b=1',
    ]);
    expect(urlsIn('Launch is Nov 12')).toEqual([]);
  });

  test('a URL the page cites or contains already is not new', () => {
    const known = ['- Price ⟦1⟧ from https://example.com/pricing', 'https://acme.test/docs'];
    expect(newUrls('Price is $49 (https://example.com/pricing)', known)).toEqual([]);
    expect(newUrls('Docs at https://acme.test/docs/ and https://acme.test/new', known)).toEqual(['https://acme.test/docs/', 'https://acme.test/new']);
  });

  test('the "(to confirm)" title stays within 120 characters', () => {
    expect(pendingTitle('Q4 launch')).toBe('Q4 launch (to confirm)');
    expect(pendingTitle('x'.repeat(120))).toHaveLength(120);
  });

  test('a source label is the host', () => {
    expect(hostOf('https://news.example.com/a/b')).toBe('news.example.com');
  });
});
