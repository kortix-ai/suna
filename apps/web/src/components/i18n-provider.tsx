'use client';

import { useAuth } from '@/features/providers/auth-provider';
import { catalogHref } from '@/i18n/catalog-href';
import { loadClientCatalog, type MessageTree } from '@/i18n/client-catalog';
import { defaultLocale, locales, type Locale } from '@/i18n/config';
import { getUserLocale, LOCALE_CHANGE_EVENT } from '@/i18n/locale';
import { serverMessagesRegistry } from '@/i18n/server-registry';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';
import { ReactNode, Suspense, use, useCallback, useEffect, useRef, useState } from 'react';
import { preload } from 'react-dom';

/**
 * Message delivery. No string ever renders from a partial catalog.
 *
 * - SSR renders against the full catalog that the RSC layer loaded
 *   (`i18n/messages.ts`). The HTML carries no messages.
 * - The page head preloads `/i18n/<locale>.<hash>.json`, so the catalog
 *   downloads in parallel with the app JavaScript and is cached across pages,
 *   visits, and deploys that do not change it.
 * - On the client, the tree below this provider hydrates only once that catalog
 *   has resolved. Until then React keeps the server HTML (a dehydrated Suspense
 *   boundary), which already shows every string of the first paint. Content
 *   that appears after mount (dialogs, auth-dependent controls) therefore
 *   always renders with the full catalog.
 */

const hydrationCatalogs = new Map<Locale, Promise<MessageTree>>();

/** The catalog hydration waits for. Never rejects: a total load failure
 *  hydrates with no messages (keys render) instead of an error screen. */
function hydrationCatalog(locale: Locale): Promise<MessageTree> {
  let promise = hydrationCatalogs.get(locale);
  if (!promise) {
    promise = loadClientCatalog(locale).catch((error: unknown) => {
      console.error(`[i18n] could not load the ${locale} catalog:`, error);
      return {};
    });
    hydrationCatalogs.set(locale, promise);
  }
  return promise;
}

function serverCatalog(locale: Locale): MessageTree {
  const catalog = serverMessagesRegistry()[locale];
  if (!catalog) {
    // The root layout loads the catalog before it renders this provider.
    throw new Error(`I18nProvider: no server catalog loaded for locale "${locale}"`);
  }
  return catalog;
}

export function I18nProvider({
  children,
  initialLocale = defaultLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  // Emitted into <head> during SSR, ahead of the app scripts.
  preload(catalogHref(initialLocale), { as: 'fetch', crossOrigin: 'anonymous' });
  return (
    <Suspense fallback={null}>
      <CatalogProvider initialLocale={initialLocale}>{children}</CatalogProvider>
    </Suspense>
  );
}

function CatalogProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale: Locale;
}) {
  // Always call `use` on the client. Never short-circuit it with a direct
  // cache read of an already-loaded catalog.
  //
  // React suspends this component on the first client render, then replays it
  // with the rerender dispatcher (ReactFiberHooks `useThenable`). `use` switches
  // the dispatcher back to mount/update when no hooks remain from the suspended
  // attempt. A skipped `use` leaves the rerender dispatcher in place, so the
  // first `useState` throws minified React error #467 ("Update hook called on
  // initial render") during hydration. When the catalog is already loaded,
  // `loadClientCatalog` resolves synchronously, so `use` returns without
  // suspending and the fast path is preserved.
  const initialCatalog =
    typeof window === 'undefined'
      ? serverCatalog(initialLocale)
      : use(hydrationCatalog(initialLocale));

  const { user } = useAuth();
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [messages, setMessages] = useState<MessageTree>(initialCatalog);
  const localeRef = useRef(locale);

  // Keep <html lang> in sync with the active locale. Chrome offers
  // auto-translate on a page whose lang does not match its text, and its DOM
  // mutations crash React's reconciler ("insertBefore on Node").
  useEffect(() => {
    localeRef.current = locale;
    document.documentElement.lang = locale;
  }, [locale]);

  const loadTranslations = useCallback(async (targetLocale: Locale) => {
    try {
      const translations = await loadClientCatalog(targetLocale);
      setMessages(translations);
      setLocale(targetLocale);
      localeRef.current = targetLocale;
    } catch (error) {
      // Keep the current catalog: every string stays rendered.
      console.error(`Failed to load translations for ${targetLocale}:`, error);
    }
  }, []);

  // Only the profile locale can move the app away from the rendered locale.
  // Signing out returns to the locale the page rendered in.
  useEffect(() => {
    const target = getUserLocale(user) ?? initialLocale;
    if (target !== localeRef.current) void loadTranslations(target);
  }, [initialLocale, loadTranslations, user]);

  // Locale change events from the useLanguage hook.
  useEffect(() => {
    const handleLocaleChange = (e: CustomEvent<Locale>) => {
      const newLocale = e.detail;
      if (newLocale !== localeRef.current && locales.includes(newLocale)) {
        void loadTranslations(newLocale);
      }
    };

    window.addEventListener(LOCALE_CHANGE_EVENT as any, handleLocaleChange as EventListener);

    return () => {
      window.removeEventListener(LOCALE_CHANGE_EVENT as any, handleLocaleChange as EventListener);
    };
  }, [loadTranslations]);

  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages as AbstractIntlMessages}
      timeZone="UTC"
    >
      {children}
    </NextIntlClientProvider>
  );
}
