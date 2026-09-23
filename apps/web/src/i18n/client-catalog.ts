import type { Locale } from './config';
import type { MessageTree } from './message-subset';

/**
 * Browser loader for full locale catalogs.
 *
 * Each catalog is its own content-hashed chunk, so the browser caches it across
 * pages and visits. The server never calls this: SSR reads the catalog that
 * the RSC layer already loaded (see `messages.ts`). The `typeof window` guard
 * is replaced at compile time, so the SSR bundle drops these imports and the
 * server trace keeps one copy of each catalog.
 */
const loaded = new Map<Locale, MessageTree>();
const loading = new Map<Locale, Promise<MessageTree>>();

function importCatalog(locale: Locale): Promise<{ default: unknown }> {
  // Keep every import inside this branch. On the server `typeof window` is
  // the constant 'undefined', so the whole branch and its chunks drop out.
  if (typeof window !== 'undefined') {
    switch (locale) {
      case 'de':
        return import('../../translations/de.json');
      case 'it':
        return import('../../translations/it.json');
      case 'zh':
        return import('../../translations/zh.json');
      case 'ja':
        return import('../../translations/ja.json');
      case 'pt':
        return import('../../translations/pt.json');
      case 'fr':
        return import('../../translations/fr.json');
      case 'es':
        return import('../../translations/es.json');
      case 'sr':
        return import('../../translations/sr.json');
      default:
        return import('../../translations/en.json');
    }
  }
  return Promise.reject(new Error('loadClientCatalog runs in the browser only'));
}

export function getLoadedCatalog(locale: Locale): MessageTree | undefined {
  return loaded.get(locale);
}

export function loadClientCatalog(locale: Locale): Promise<MessageTree> {
  const ready = loaded.get(locale);
  if (ready) return Promise.resolve(ready);
  let promise = loading.get(locale);
  if (!promise) {
    promise = importCatalog(locale).then(
      (module) => {
        const messages = module.default as MessageTree;
        loaded.set(locale, messages);
        loading.delete(locale);
        return messages;
      },
      (error: unknown) => {
        loading.delete(locale);
        throw error;
      },
    );
    loading.set(locale, promise);
  }
  return promise;
}
