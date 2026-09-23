import { describe, expect, test } from 'bun:test';

import { loadLocaleBundle, resolveBootLocale } from './boot-locale';
import { SUPPORTED_LOCALES } from './locale-config';

describe('resolveBootLocale', () => {
  test('no user boots in English', () => {
    expect(resolveBootLocale(null)).toBe('en');
    expect(resolveBootLocale(undefined)).toBe('en');
  });

  test('a user without a profile locale boots in English', () => {
    expect(resolveBootLocale({})).toBe('en');
    expect(resolveBootLocale({ user_metadata: {} })).toBe('en');
  });

  test('an unsupported or malformed profile locale boots in English', () => {
    expect(resolveBootLocale({ user_metadata: { locale: 'ko' } })).toBe('en');
    expect(resolveBootLocale({ user_metadata: { locale: 42 } })).toBe('en');
  });

  test('a supported profile locale wins', () => {
    expect(resolveBootLocale({ user_metadata: { locale: 'fr' } })).toBe('fr');
    expect(resolveBootLocale({ user_metadata: { locale: 'ja' } })).toBe('ja');
  });
});

describe('loadLocaleBundle', () => {
  test.each([...SUPPORTED_LOCALES])('%s resolves a non-empty translation bundle', (locale) => {
    const bundle = loadLocaleBundle(locale);
    expect(typeof bundle).toBe('object');
    expect(Object.keys(bundle).length).toBeGreaterThan(0);
  });

  test('every locale bundle is distinct from English except English itself', () => {
    const en = loadLocaleBundle('en');
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === 'en') continue;
      expect(loadLocaleBundle(locale)).not.toBe(en);
    }
  });
});
