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

/**
 * `next dev` re-imports on every call. The bundler hot-reloads the JSON
 * module when a catalog is saved, but this process-wide cache would keep
 * serving the copy from the first request — a key added mid-session rendered
 * as its raw path until the server restarted. Production caches as before.
 */
const LIVE_CATALOGS = process.env.NODE_ENV === 'development';

export function loadMessages(locale: Locale): Promise<Messages> {
  if (LIVE_CATALOGS) {
    return LOADERS[locale]().then((module) => {
      const messages = module.default as Messages;
      // Still published: the client provider seeds its SSR render from here.
      serverMessagesRegistry()[locale] = messages;
      return messages;
    });
  }
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
