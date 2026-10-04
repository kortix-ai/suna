import { catalogHref } from './catalog-href';
import { CATALOG_LOADERS } from './catalog-loaders';
import type { Locale } from './config';

export type MessageTree = Record<string, unknown>;

/**
 * Browser loader for full locale catalogs.
 *
 * Primary source: `/i18n/<locale>.<hash>.json`, the URL the page head
 * preloads, so this fetch reuses the in-flight or finished preload. Fallback:
 * the same JSON as a bundler chunk, if the fetch fails. The server never calls
 * this: SSR reads the catalog that the RSC layer already loaded (see
 * `messages.ts`). The fallback loads from the shared `CATALOG_LOADERS` table,
 * so the browser and server builds emit each catalog chunk once.
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
  // The guard stays here, around the CALL. On the server `typeof window` is
  // the constant 'undefined', so the whole branch drops out of the SSR bundle;
  // the chunks themselves are emitted once per compilation by the shared
  // table in `catalog-loaders.ts`.
  if (typeof window !== 'undefined') {
    return CATALOG_LOADERS[locale]();
  }
  return Promise.reject(new Error('loadClientCatalog runs in the browser only'));
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
