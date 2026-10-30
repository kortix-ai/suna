import { describe, expect, test } from 'bun:test';

import { parseAppReturnUrl, resolveAppReturn } from './app-return-url';

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

describe('resolveAppReturn', () => {
  const fromUrl = 'kortix://connectors/done';
  const remembered = 'kortix://connectors/remembered';

  test('the URL value wins over the remembered one', () => {
    expect(resolveAppReturn(fromUrl, remembered)).toBe(fromUrl);
  });

  test('falls back to the remembered value when the URL carries none', () => {
    expect(resolveAppReturn(null, remembered)).toBe(remembered);
  });

  test('rejects an invalid remembered value', () => {
    // Storage is as user-writable as the query string.
    expect(resolveAppReturn(null, 'https://evil.example/phish')).toBeNull();
    expect(resolveAppReturn(null, 'javascript:alert(1)')).toBeNull();
  });

  test('is null when both are absent', () => {
    expect(resolveAppReturn(null, null)).toBeNull();
  });

  test('an invalid URL value does not block a valid remembered one', () => {
    expect(resolveAppReturn('https://evil.example/phish', remembered)).toBe(remembered);
  });
});
