import type { UiTranslator } from './translator';

export type UiCatalogTranslationKeys = Readonly<Record<string, string>>;

const DISPLAY_PROPERTIES = new Set([
  'ask',
  'body',
  'caption',
  'desc',
  'detail',
  'description',
  'emptyLabel',
  'emptyText',
  'errorMessage',
  'eyebrow',
  'helperText',
  'heading',
  'label',
  'markdown',
  'message',
  'pitch',
  'prompt',
  'reply',
  'sub',
  'summary',
  'subtitle',
  'successMessage',
  'thinkingLabel',
  'title',
  'tooltip',
]);

export function translateUiCatalogText(
  value: string,
  tI18nComplete: UiTranslator,
  translationKeys: UiCatalogTranslationKeys,
): string {
  if (value.length === 0) return value;
  const key = translationKeys[value];
  return key ? tI18nComplete.raw(key as Parameters<UiTranslator['raw']>[0]) : value;
}

export function localizeUiCatalog<T>(
  value: T,
  tI18nComplete: UiTranslator,
  translationKeys: UiCatalogTranslationKeys,
): T {
  if (typeof value === 'string') {
    return translateUiCatalogText(value, tI18nComplete, translationKeys) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => localizeUiCatalog(item, tI18nComplete, translationKeys)) as T;
  }

  if (!value || typeof value !== 'object' || '$$typeof' in value) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (typeof entry === 'string' && DISPLAY_PROPERTIES.has(key)) {
        return [key, translateUiCatalogText(entry, tI18nComplete, translationKeys)];
      }
      return [key, localizeUiCatalog(entry, tI18nComplete, translationKeys)];
    }),
  ) as T;
}
