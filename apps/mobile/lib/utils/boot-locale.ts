import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from './locale-config';

type TranslationBundle = Record<string, unknown>;

/**
 * The language to show for a signed-in user. The profile locale wins; without
 * one the app stays in English. Device locale never switches language.
 */
export function resolveBootLocale(
  user: { user_metadata?: { locale?: unknown } } | null | undefined
): SupportedLocale {
  const locale = user?.user_metadata?.locale;
  return typeof locale === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(locale)
    ? (locale as SupportedLocale)
    : DEFAULT_LOCALE;
}

/**
 * Loads one locale's translations. Each bundle is 48–60 KB of JSON, so only
 * the locale in use is evaluated. Static `require` strings keep every bundle
 * in the Metro build.
 */
export function loadLocaleBundle(locale: SupportedLocale): TranslationBundle {
  switch (locale) {
    case 'en':
      return require('../../locales/en.json');
    case 'de':
      return require('../../locales/de.json');
    case 'it':
      return require('../../locales/it.json');
    case 'zh':
      return require('../../locales/zh.json');
    case 'ja':
      return require('../../locales/ja.json');
    case 'pt':
      return require('../../locales/pt.json');
    case 'fr':
      return require('../../locales/fr.json');
    case 'es':
      return require('../../locales/es.json');
  }
}
