import type { Locale } from './config';
import { CATALOG_LOADERS } from './catalog-loaders';
import { serverMessagesRegistry } from './server-registry';

/**
 * Server-side loader for one locale catalog.
 *
 * Every server path (request config, metadata, isolated fallbacks) goes
 * through this module, so each catalog exists once in the server output.
 *
 * The loaded catalog is also published in a process-wide registry. The client
 * `I18nProvider` reads that registry during SSR instead of importing the JSON a
 * second time. The RSC and SSR layers run in one process, and the root layout
 * resolves the catalog before it renders the provider, so the entry is present.
 */
export type Messages = Record<string, unknown>;

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
    return CATALOG_LOADERS[locale]().then((module) => {
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
    promise = CATALOG_LOADERS[locale]().then((module) => {
      const messages = module.default as Messages;
      serverMessagesRegistry()[locale] = messages;
      return messages;
    });
    pending.set(locale, promise);
  }
  return promise;
}
