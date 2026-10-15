import { describe, expect, test } from 'bun:test';
import i18next from 'i18next';

import { SUPPORTED_LOCALES } from '@/lib/utils/locale-config';

// Who stopped a shared session's turn ("Stopped by {name}" under the turn) and
// the toast for a refused stop resolve in every locale from its own bundle,
// translated, never an English copy.

const KEYS = ['sessions.stoppedBy', 'sessions.stopNotAllowed'];

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

describe('turn stop strings', () => {
  test('English reads as the turn and the toast show it', async () => {
    const en = await instanceFor('en');
    expect(en.t('sessions.stoppedBy', { name: 'Ada' })).toBe('Stopped by Ada');
    // The API's 403 `not_turn_prompter` message, word for word.
    expect(en.t('sessions.stopNotAllowed')).toBe(
      'Only the member who started this run, the session owner or a project manager can stop it.',
    );
  });

  for (const locale of SUPPORTED_LOCALES.filter((locale) => locale !== 'en')) {
    test(`${locale} has its own translation of every key, with the name in it`, async () => {
      const i18n = await instanceFor(locale);
      const en = await instanceFor('en');
      for (const key of KEYS) {
        // No fallback to English: the locale's own bundle holds the key.
        expect(i18n.exists(key, { lng: locale, fallbackLng: false })).toBe(true);
        const text = i18n.t(key);
        expect(text.trim().length).toBeGreaterThan(0);
        expect(text).not.toBe(en.t(key));
      }
      expect(i18n.t('sessions.stoppedBy', { name: 'Ada' })).toContain('Ada');
    });
  }
});
