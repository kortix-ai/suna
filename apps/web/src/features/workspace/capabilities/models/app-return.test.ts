import { describe, expect, test } from 'bun:test';

import { parseAppReturnUrl, usableModelCount } from './app-return';

describe('parseAppReturnUrl', () => {
  test('accepts a kortix: URL unchanged', () => {
    expect(parseAppReturnUrl('kortix://providers/connected')).toBe('kortix://providers/connected');
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

describe('usableModelCount', () => {
  test('counts enabled models and skips auto, like the mobile picker', () => {
    expect(
      usableModelCount([
        { modelID: 'auto' },
        { modelID: 'kortix/auto' },
        { modelID: 'claude-sonnet', enabled: false },
        { modelID: 'gpt-5' },
        { modelID: 'claude-opus', enabled: true },
      ]),
    ).toBe(2);
  });

  test('is zero for an empty catalog', () => {
    expect(usableModelCount([])).toBe(0);
  });
});
