import type { Locale } from './config';

/**
 * One literal `import()` per locale. The bundler emits one chunk per catalog,
 * and a request loads only the catalog of its resolved locale. Both consumers
 * — the server loader (`messages.ts`) and the browser fallback
 * (`client-catalog.ts`) — go through this one table, so each catalog chunk is
 * emitted exactly once per compilation.
 */
export const CATALOG_LOADERS: Record<Locale, () => Promise<{ default: unknown }>> = {
  en: () => import('../../translations/en.json'),
  de: () => import('../../translations/de.json'),
  it: () => import('../../translations/it.json'),
  zh: () => import('../../translations/zh.json'),
  ja: () => import('../../translations/ja.json'),
  pt: () => import('../../translations/pt.json'),
  fr: () => import('../../translations/fr.json'),
  es: () => import('../../translations/es.json'),
  sr: () => import('../../translations/sr.json'),
};
