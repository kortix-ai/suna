import { hero } from '@/features/marketing/enterprise/content';
import { localizeUiCatalog } from '@kortix/ui/i18n';
import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import de from '../../translations/de.json';
import en from '../../translations/en.json';
import { MARKETING_RELEASE_TRANSLATION_KEYS } from './marketing-release-translation-keys.generated';

describe('release marketing catalogs', () => {
  test('marketing authoring data renders the selected locale rather than English', () => {
    const translator = createTranslator({
      locale: 'de',
      messages: de,
      namespace: 'hardcodedUi.i18nComplete',
    });
    const localized = localizeUiCatalog(hero, translator, MARKETING_RELEASE_TRANSLATION_KEYS);
    expect(localized).not.toEqual(hero);
    expect(localized.title).toBe(translator.raw(MARKETING_RELEASE_TRANSLATION_KEYS[hero.title]));
  });
  test('dynamic walkthrough labels interpolate their arguments', () => {
    const translator = createTranslator({
      locale: 'en',
      messages: en,
      namespace: 'hardcodedUi.i18nComplete',
    });
    const key = MARKETING_RELEASE_TRANSLATION_KEYS['Arcadia · {project} → Access'];
    expect(translator(key, { project: 'Billing' })).toBe('Arcadia · Billing → Access');
  });
});
