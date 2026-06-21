import { describe, expect, test } from 'bun:test';

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './locale-config';

describe('mobile locale config', () => {
  test('defaults to English', () => {
    expect(DEFAULT_LOCALE).toBe('en');
  });

  test('keeps web-supported locales available for explicit profile settings', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'de', 'it', 'zh', 'ja', 'pt', 'fr', 'es']);
  });
});
