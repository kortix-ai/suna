import {
  createTranslator,
  useLocale as useNextLocale,
  useTranslations as useNextTranslations,
} from 'next-intl';

import messages from '../../translations/en.json';

export * from 'next-intl';

const callNextLocale = useNextLocale;

/** Uses the active locale and defaults isolated component tests to English. */
export const useLocale: typeof useNextLocale = (() => {
  try {
    return callNextLocale();
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') throw error;
    return 'en';
  }
}) as typeof useNextLocale;

const fallbackTranslators = new Map<string, unknown>();
const callNextTranslations = useNextTranslations;

function fallbackTranslator(namespace?: string) {
  const key = namespace ?? '';
  let translator = fallbackTranslators.get(key);
  if (!translator) {
    translator = createTranslator({
      locale: 'en',
      messages,
      namespace: namespace as never,
    });
    fallbackTranslators.set(key, translator);
  }
  return translator as (...args: unknown[]) => unknown;
}

function isMissingResult(value: unknown, namespace: string | undefined, key: unknown): boolean {
  if (typeof value !== 'string' || typeof key !== 'string') return false;
  return value === key || value === (namespace ? `${namespace}.${key}` : key);
}

function withEnglishTestFallback(primary: (...args: unknown[]) => unknown, namespace?: string) {
  const fallback = fallbackTranslator(namespace) as typeof primary & Record<string, unknown>;
  const translated = ((...args: unknown[]) => {
    const value = primary(...args);
    return isMissingResult(value, namespace, args[0]) ? fallback(...args) : value;
  }) as typeof primary & Record<string, unknown>;

  for (const method of ['raw', 'rich', 'markup'] as const) {
    const primaryMethod = (primary as typeof fallback)[method];
    const fallbackMethod = fallback[method];
    if (typeof primaryMethod !== 'function' || typeof fallbackMethod !== 'function') continue;
    translated[method] = (...args: unknown[]) => {
      const value = primaryMethod(...args);
      return isMissingResult(value, namespace, args[0]) ? fallbackMethod(...args) : value;
    };
  }

  translated.has = (key: unknown) => {
    const primaryHas = (primary as typeof fallback).has;
    const fallbackHas = fallback.has;
    return (
      (typeof primaryHas === 'function' && primaryHas(key)) ||
      (typeof fallbackHas === 'function' && fallbackHas(key))
    );
  };
  return translated;
}

/**
 * Uses the active next-intl provider in the application.
 *
 * Isolated component tests intentionally render presentational components
 * without the application provider tree. Those tests receive English copy so
 * localization does not turn a pure view into a provider-dependent view.
 */
export const useTranslations: typeof useNextTranslations = ((namespace?: string) => {
  try {
    const translator = callNextTranslations(namespace as never);
    return process.env.NODE_ENV === 'test'
      ? withEnglishTestFallback(translator as never, namespace)
      : translator;
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') throw error;
    return fallbackTranslator(namespace);
  }
}) as typeof useNextTranslations;
