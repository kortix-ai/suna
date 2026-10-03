import { describe, expect, test } from 'bun:test';
import i18next from 'i18next';

import { SUPPORTED_LOCALES } from '@/lib/utils/locale-config';

// The sub-session tree's "Show N more" strings resolve in every locale, in the
// singular and the plural, with the count and the parent title filled in.

const KEYS = ['sessions.showMoreSubsessions', 'sessions.showMoreSubsessionsLabel'] as const;

async function instanceFor(locale: string) {
  const i18n = i18next.createInstance();
  await i18n.init({
    resources: {
      en: { translation: require('./en.json') },
      [locale]: { translation: require(`./${locale}.json`) },
    },
    lng: locale,
    fallbackLng: 'en',
    compatibilityJSON: 'v4',
    interpolation: { escapeValue: false },
  });
  return i18n;
}

describe('sub-session "Show N more" strings', () => {
  for (const locale of SUPPORTED_LOCALES) {
    test(`${locale} has its own singular and plural forms`, async () => {
      const i18n = await instanceFor(locale);
      for (const key of KEYS) {
        for (const count of [1, 3]) {
          // No fallback to English: the locale's own bundle holds the key.
          expect(i18n.exists(key, { count, lng: locale, fallbackLng: false })).toBe(true);
          const text = i18n.t(key, { count, title: 'Fix the build' });
          expect(text).toContain(String(count));
          expect(text).not.toContain('{{');
          if (key.endsWith('Label')) expect(text).toContain('Fix the build');
        }
      }
    });
  }

  test('English uses the singular for one', async () => {
    const i18n = await instanceFor('en');
    expect(i18n.t('sessions.showMoreSubsessionsLabel', { count: 1, title: 'P' })).toBe('Show 1 more sub-session of P');
    expect(i18n.t('sessions.showMoreSubsessionsLabel', { count: 2, title: 'P' })).toBe('Show 2 more sub-sessions of P');
    expect(i18n.t('sessions.showMoreSubsessions', { count: 2 })).toBe('Show 2 more');
  });

  // Hermes ships without Intl.PluralRules. i18next then maps count 1 to `_one`
  // in every language, so a locale with only `_other` falls back to English.
  test('Japanese and Chinese stay localized for one without Intl.PluralRules', async () => {
    const intl = Intl as { PluralRules?: typeof Intl.PluralRules };
    const pluralRules = intl.PluralRules;
    delete intl.PluralRules;
    try {
      const ja = await instanceFor('ja');
      expect(ja.t('sessions.showMoreSubsessions', { count: 1 })).toBe('さらに1件を表示');
      expect(ja.t('sessions.showMoreSubsessionsLabel', { count: 1, title: 'P' })).toBe('P のサブセッションをさらに1件表示');
      const zh = await instanceFor('zh');
      expect(zh.t('sessions.showMoreSubsessions', { count: 1 })).toBe('再显示 1 个');
    } finally {
      intl.PluralRules = pluralRules;
    }
  });
});
