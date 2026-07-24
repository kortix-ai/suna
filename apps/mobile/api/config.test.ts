import { describe, expect, test } from 'bun:test';
import { inferFrontendUrl } from './frontend-url';

describe('inferFrontendUrl', () => {
  test('maps exact Kortix API hosts', () => {
    expect(inferFrontendUrl('https://api.kortix.com/v1')).toBe('https://kortix.com');
    expect(inferFrontendUrl('https://staging-api.kortix.com/v1')).toBe('https://staging.kortix.com');
  });

  test.each([
    'https://api.kortix.com.attacker.example/v1',
    'https://attacker.example/api.kortix.com',
    'not a URL',
  ])('does not trust a substring match: %s', (backendUrl) => {
    expect(inferFrontendUrl(backendUrl)).toBeNull();
  });
});
