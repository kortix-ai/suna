import { describe, expect, test } from 'bun:test';

import { SUPPORTED_LOCALES } from '@/lib/utils/locale-config';

// The email screen's SSO-required notice (KRTX-1716): every locale has its
// own string, not the English fallback.

const en: string = require('./en.json').auth.ssoRequired;

describe('auth.ssoRequired string', () => {
  test('English is the screen default', () => {
    expect(en).toBe('Your organization requires single sign-on. Continue with SSO instead.');
  });

  for (const locale of SUPPORTED_LOCALES.filter((l) => l !== 'en')) {
    test(`${locale} has its own translation`, () => {
      const text: string = require(`./${locale}.json`).auth.ssoRequired;
      expect(text).toBeTruthy();
      expect(text).not.toBe(en);
      expect(text).toContain('SSO');
    });
  }
});
