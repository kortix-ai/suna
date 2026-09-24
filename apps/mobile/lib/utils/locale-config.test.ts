import { describe, expect, test } from 'bun:test';

import { DEFAULT_LOCALE, LANGUAGE_PICKER_ENABLED, SUPPORTED_LOCALES } from './locale-config';

describe('mobile locale config', () => {
  test('defaults to English', () => {
    expect(DEFAULT_LOCALE).toBe('en');
  });

  test('keeps web-supported locales available for explicit profile settings', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'de', 'it', 'zh', 'ja', 'pt', 'fr', 'es']);
  });

  test('language picker stays hidden until the core screens are translated', () => {
    // Flip only after projects, session, composer and drawer use locales/*.json.
    expect(LANGUAGE_PICKER_ENABLED).toBe(false);
  });
});
