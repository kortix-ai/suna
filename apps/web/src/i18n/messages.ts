import type { Locale } from './config';
import { serverMessagesRegistry } from './server-registry';

/**
 * Server-side loader for one locale catalog.
 *
 * One literal `import()` per locale. The bundler emits one chunk per catalog,
 * and a request loads only the catalog of its resolved locale. Every server
 * path (request config, metadata, isolated fallbacks) goes through this module,
 * so each catalog exists once in the server output.
 *
 * The loaded catalog is also published in a process-wide registry. The client
 * `I18nProvider` reads that registry during SSR instead of importing the JSON a
 * second time. The RSC and SSR layers run in one process, and the root layout
 * resolves the catalog before it renders the provider, so the entry is present.
 */
export type Messages = Record<string, unknown>;

const LOADERS: Record<Locale, () => Promise<{ default: unknown }>> = {
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

const pending = new Map<Locale, Promise<Messages>>();

export function loadMessages(locale: Locale): Promise<Messages> {
  const cached = serverMessagesRegistry()[locale];
  if (cached) return Promise.resolve(cached);
  let promise = pending.get(locale);
  if (!promise) {
    promise = LOADERS[locale]().then((module) => {
      const messages = module.default as Messages;
      serverMessagesRegistry()[locale] = messages;
      return messages;
    });
    pending.set(locale, promise);
  }
  return promise;
}
