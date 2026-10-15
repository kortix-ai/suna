import { describe, expect, test } from 'bun:test';
import i18next from 'i18next';

import { SUPPORTED_LOCALES } from '@/lib/utils/locale-config';

// KRTX-2418: the Pin and Archive strings (the session actions sheet, the
// drawer's Pinned section, the Sessions page's Archived view) resolve in every
// locale from its own bundle, translated, never an English copy.

const ACTIONS = ['pin', 'unpin', 'archive', 'unarchive'] as const;
const KEYS = [
  ...ACTIONS.flatMap((action) => [`sessions.${action}`, `sessions.${action}Done`, `sessions.${action}Failed`]),
  'sessions.undo',
  'sessions.pinnedSection',
  'sessions.archivedView',
  'sessions.archivedEmpty',
];

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

describe('pin and archive strings', () => {
  test('English reads as the sheet, drawer and Sessions page show it', async () => {
    const en = await instanceFor('en');
    expect(en.t('sessions.pin')).toBe('Pin');
    expect(en.t('sessions.unarchive')).toBe('Unarchive');
    expect(en.t('sessions.archiveDone')).toBe('Session archived');
    expect(en.t('sessions.pinFailed')).toBe('Could not pin the session. Try again.');
    expect(en.t('sessions.pinnedSection')).toBe('Pinned');
    expect(en.t('sessions.archivedEmpty')).toBe('Sessions you archive will show up here.');
  });

  for (const locale of SUPPORTED_LOCALES.filter((locale) => locale !== 'en')) {
    test(`${locale} has its own translation of every key`, async () => {
      const i18n = await instanceFor(locale);
      const en = await instanceFor('en');
      for (const key of KEYS) {
        // No fallback to English: the locale's own bundle holds the key.
        expect(i18n.exists(key, { lng: locale, fallbackLng: false })).toBe(true);
        const text = i18n.t(key);
        expect(text.trim().length).toBeGreaterThan(0);
        expect(text).not.toBe(en.t(key));
      }
    });
  }
});
