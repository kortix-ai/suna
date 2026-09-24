import { catalogHref } from './catalog-href';
import type { Locale } from './config';

export type MessageTree = Record<string, unknown>;

/**
 * Browser loader for full locale catalogs.
 *
 * Primary source: `/i18n/<locale>.<hash>.json`, the URL the page head
 * preloads, so this fetch reuses the in-flight or finished preload. Fallback:
 * the same JSON as a bundler chunk, if the fetch fails. The server never calls
 * this: SSR reads the catalog that the RSC layer already loaded (see
 * `messages.ts`). The `typeof window` guard is replaced at compile time, so the
 * SSR bundle drops the chunk imports.
 */
const loaded = new Map<Locale, MessageTree>();
const loading = new Map<Locale, Promise<MessageTree>>();

async function fetchCatalog(locale: Locale): Promise<MessageTree> {
  // Same mode and credentials as the <link rel=preload as=fetch crossorigin>
  // the provider emits, so the browser matches the request to the preload.
  const response = await fetch(catalogHref(locale), { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`catalog ${locale}: HTTP ${response.status}`);
  return (await response.json()) as MessageTree;
}

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
    promise = fetchCatalog(locale)
      .catch((error: unknown) => {
        console.warn(`[i18n] ${String(error)}; loading the bundled catalog`);
        return importCatalog(locale).then((module) => module.default as MessageTree);
      })
      .then(
        (messages) => {
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
