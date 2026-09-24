import type { Locale } from './config';

/**
 * Process-wide registry of server-loaded catalogs.
 *
 * `messages.ts` (RSC layer) fills it. The client `I18nProvider` reads it during
 * SSR. Both layers run in one process, and this module holds no imports of the
 * catalogs, so the SSR layer reuses the RSC copy instead of bundling its own.
 */
const REGISTRY_KEY = Symbol.for('kortix.i18n.server-messages');

type Registry = Partial<Record<Locale, Record<string, unknown>>>;

export function serverMessagesRegistry(): Registry {
  const holder = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
  holder[REGISTRY_KEY] ??= {};
  return holder[REGISTRY_KEY];
}
