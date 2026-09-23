'use client';

import { useAuth } from '@/features/providers/auth-provider';
import { getLoadedCatalog, loadClientCatalog } from '@/i18n/client-catalog';
import { defaultLocale, locales, type Locale } from '@/i18n/config';
import { getUserLocale, LOCALE_CHANGE_EVENT, normalizeLocale } from '@/i18n/locale';
import {
  CLIENT_BOOT_GLOBAL,
  clientBootScript,
  createMessageRecorder,
  type ClientBoot,
  type MessageRecorder,
  type MessageTree,
} from '@/i18n/message-subset';
import { serverMessagesRegistry } from '@/i18n/server-registry';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';
import { useServerInsertedHTML } from 'next/navigation';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';

/**
 * Message delivery.
 *
 * - SSR renders against the full catalog that the RSC layer loaded, through a
 *   recording view. Inline boot scripts carry only the entries that render
 *   read (`message-subset.ts`).
 * - Hydration starts from that subset, so it never waits for a catalog.
 * - The full catalog loads as its own cached chunk and replaces the subset.
 *   Until it lands, an entry outside the subset renders as an empty string,
 *   and the provider re-renders once the catalog arrives.
 */

function readClientBoot(locale: Locale): MessageTree | undefined {
  if (typeof window === 'undefined') return undefined;
  const boot = (window as unknown as Record<string, ClientBoot | undefined>)[CLIENT_BOOT_GLOBAL];
  return boot && boot.l === locale ? boot.m : undefined;
}

// Start the catalog fetch as early as possible: the server-rendered
// <html lang> names the locale before any component renders.
if (typeof document !== 'undefined') {
  const documentLocale = normalizeLocale(document.documentElement.lang);
  if (documentLocale) void loadClientCatalog(documentLocale).catch(() => {});
}

function useServerMessages(locale: Locale): MessageRecorder | null {
  // SSR only: one recorder per request render. The browser keeps `null`.
  const [recorder] = useState<MessageRecorder | null>(() => {
    if (typeof window !== 'undefined') return null;
    const catalog = serverMessagesRegistry()[locale];
    if (!catalog) {
      // The root layout loads the catalog before it renders this provider.
      throw new Error(`I18nProvider: no server catalog loaded for locale "${locale}"`);
    }
    return createMessageRecorder(catalog);
  });
  useServerInsertedHTML(() => {
    const delta = recorder?.takeDelta();
    if (!delta) return null;
    return (
      <script
        key="kortix-i18n-boot"
        dangerouslySetInnerHTML={{ __html: clientBootScript(locale, delta) }}
      />
    );
  });
  return recorder;
}

export function I18nProvider({
  children,
  initialLocale = defaultLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const { user } = useAuth();
  const recorder = useServerMessages(initialLocale);
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [messages, setMessages] = useState<MessageTree>(
    () =>
      recorder?.messages ?? getLoadedCatalog(initialLocale) ?? readClientBoot(initialLocale) ?? {},
  );
  const [catalogReady, setCatalogReady] = useState<boolean>(
    () => recorder !== null || getLoadedCatalog(initialLocale) !== undefined,
  );
  const localeRef = useRef(locale);

  // Keep <html lang> in sync with the active locale. Chrome offers
  // auto-translate on a page whose lang does not match its text, and its DOM
  // mutations crash React's reconciler ("insertBefore on Node").
  useEffect(() => {
    localeRef.current = locale;
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const loadTranslations = useCallback(async (targetLocale: Locale) => {
    try {
      const translations = await loadClientCatalog(targetLocale);
      setMessages(translations);
      setLocale(targetLocale);
      setCatalogReady(true);
      localeRef.current = targetLocale;
    } catch (error) {
      console.error(`Failed to load translations for ${targetLocale}:`, error);
      if (targetLocale === defaultLocale) return;
      try {
        const fallback = await loadClientCatalog(defaultLocale);
        setMessages(fallback);
        setLocale(defaultLocale);
        setCatalogReady(true);
        localeRef.current = defaultLocale;
      } catch (fallbackError) {
        console.error('Failed to load default locale translations:', fallbackError);
      }
    }
  }, []);

  // Only the profile locale can move the app away from the rendered locale.
  // Otherwise this replaces the hydration subset with the full catalog.
  useEffect(() => {
    void loadTranslations(getUserLocale(user) ?? initialLocale);
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
      {...(catalogReady ? {} : PENDING_CATALOG_HANDLERS)}
    >
      {children}
    </NextIntlClientProvider>
  );
}

// While only the hydration subset is present, an entry outside it is not an
// error: the full catalog is on its way. Render nothing instead of the raw key.
const PENDING_CATALOG_HANDLERS = {
  onError: () => {},
  getMessageFallback: () => '',
};
