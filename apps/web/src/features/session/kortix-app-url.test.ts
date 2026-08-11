import { describe, expect, test } from 'bun:test';

import { isdoscoAppUrl } from './kortix-app-url';

describe('isdoscoAppUrl', () => {
  test('keeps every dosco Apps environment on its direct origin', () => {
    expect(isdoscoAppUrl('https://dev-store-aaaaaaaaaaaaaaaa.apps.dosco.live/')).toBe(true);
    expect(isdoscoAppUrl('https://staging-demo-bbbbbbbbbbbbbbbb.apps.dosco.live/path?q=1')).toBe(true);
    expect(isdoscoAppUrl('http://aaaaaaaaaaaaaaaa.apps.localhost:8008/')).toBe(true);
  });

  test('does not bypass the sandbox web proxy for unrelated websites', () => {
    expect(isdoscoAppUrl('https://example.com/apps.dosco.live')).toBe(false);
    expect(isdoscoAppUrl('https://apps.dosco.live.evil.test/')).toBe(false);
    expect(isdoscoAppUrl('javascript:alert(1)')).toBe(false);
  });
});
