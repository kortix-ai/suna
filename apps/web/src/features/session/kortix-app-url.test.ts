import { describe, expect, test } from 'bun:test';

import { isKortixAppUrl } from './kortix-app-url';

describe('isKortixAppUrl', () => {
  test('keeps every Kortix Apps environment on its direct origin', () => {
    expect(isKortixAppUrl('https://dev-store-aaaaaaaaaaaaaaaa.apps.kortix.com/')).toBe(true);
    expect(isKortixAppUrl('https://staging-demo-bbbbbbbbbbbbbbbb.apps.kortix.com/path?q=1')).toBe(true);
    expect(isKortixAppUrl('http://aaaaaaaaaaaaaaaa.apps.localhost:8008/')).toBe(true);
  });

  test('does not bypass the sandbox web proxy for unrelated websites', () => {
    expect(isKortixAppUrl('https://example.com/apps.kortix.com')).toBe(false);
    expect(isKortixAppUrl('https://apps.kortix.com.evil.test/')).toBe(false);
    expect(isKortixAppUrl('javascript:alert(1)')).toBe(false);
  });
});
