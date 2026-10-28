import { describe, expect, test } from 'bun:test';
import i18next from 'i18next';

import { SUPPORTED_LOCALES } from '@/lib/utils/locale-config';

// The image card's states (generating, stopped, failed, the retry wait)
// resolve in every locale from its own bundle, never an English copy.

const KEYS = ['generating', 'editing', 'loading', 'stopped', 'failed', 'notLoaded', 'tapToLoad', 'openFullScreen', 'openFullScreenPrompt'].map((k) => `imageGen.${k}`);
const RETRY_KEYS = ['imageGen.retrySecond', 'imageGen.retryMinute', 'imageGen.retryHour'];
// A batch's one busy line: "Generating 3 images".
const COUNT_KEYS = ['imageGen.generatingCount', 'imageGen.editingCount'];

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

describe('image card strings', () => {
  test('English reads as the card shows it', async () => {
    const en = await instanceFor('en');
    expect(en.t('imageGen.generating')).toBe('Generating image');
    expect(en.t('imageGen.retryHour', { count: 2 })).toBe('Try again in 2 hours.');
    expect(en.t('imageGen.retryMinute', { count: 1 })).toBe('Try again in 1 minute.');
    expect(en.t('imageGen.tapToLoad', { size: '9.0 MB' })).toBe('Tap to load (9.0 MB)');
    expect(en.t('imageGen.generatingCount', { count: 3 })).toBe('Generating 3 images');
    expect(en.t('imageGen.openFullScreenPrompt', { prompt: 'a fox' })).toBe('Open full screen: a fox');
    expect(en.t('imageGen.editingCount', { count: 2 })).toBe('Editing 2 images');
  });

  for (const locale of SUPPORTED_LOCALES.filter((locale) => locale !== 'en')) {
    test(`${locale} has its own translation of every key, with the number in it`, async () => {
      const i18n = await instanceFor(locale);
      const en = await instanceFor('en');
      for (const key of KEYS) {
        expect(i18n.exists(key, { lng: locale, fallbackLng: false })).toBe(true);
        expect(i18n.t(key)).not.toBe(en.t(key));
      }
      for (const key of [...RETRY_KEYS, ...COUNT_KEYS]) {
        for (const count of [1, 5]) {
          const text = i18n.t(key, { count });
          expect(text).toContain(String(count));
          expect(text).not.toBe(en.t(key, { count }));
        }
      }
    });
  }
});
