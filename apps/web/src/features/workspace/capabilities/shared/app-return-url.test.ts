import { describe, expect, test } from 'bun:test';

import { parseAppReturnUrl } from './app-return-url';

describe('parseAppReturnUrl', () => {
  test('accepts a kortix: URL unchanged', () => {
    expect(parseAppReturnUrl('kortix://providers/connected')).toBe('kortix://providers/connected');
    expect(parseAppReturnUrl('kortix://connectors/done')).toBe('kortix://connectors/done');
  });

  test('rejects every other scheme and malformed input', () => {
    expect(parseAppReturnUrl(null)).toBeNull();
    expect(parseAppReturnUrl('')).toBeNull();
    expect(parseAppReturnUrl('https://evil.example/phish')).toBeNull();
    expect(parseAppReturnUrl('javascript:alert(1)')).toBeNull();
    expect(parseAppReturnUrl('exp://192.168.1.2:8081/--/providers')).toBeNull();
    expect(parseAppReturnUrl('//evil.example')).toBeNull();
    expect(parseAppReturnUrl('providers/connected')).toBeNull();
    expect(parseAppReturnUrl(`kortix://${'a'.repeat(300)}`)).toBeNull();
  });
});
