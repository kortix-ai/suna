'use client';

import { useAuth } from '@/features/providers/auth-provider';
import { defaultLocale, locales, type Locale } from '@/i18n/config';
import { getUserLocale, LOCALE_CHANGE_EVENT } from '@/i18n/locale';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Keep English available for callers that do not supply a server-resolved catalog.
import defaultTranslations from '../../translations/en.json';

async function getTranslations(locale: Locale): Promise<Record<string, unknown>> {
  try {
    // Return cached default translations immediately for English
    if (locale === 'en') {
      return defaultTranslations;
    }
    return (await import(`../../translations/${locale}.json`)).default;
  } catch (error) {
    console.error(`Failed to load translations for locale ${locale}:`, error);
    // Fallback to English if locale file doesn't exist
    return defaultTranslations;
  }
}

export function I18nProvider({
  children,
  initialLocale = defaultLocale,
  initialMessages = defaultTranslations,
}: {
  children: ReactNode;
  initialLocale?: Locale;
  initialMessages?: Record<string, unknown>;
}) {
  const { user } = useAuth();
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [messages, setMessages] = useState<Record<string, unknown>>(initialMessages);
  const localeRef = useRef(locale);

  // Update ref and <html lang> when locale changes.
  // Keeping <html lang> in sync with the active locale prevents browsers
  // (especially Chrome) from offering auto-translate on pages that are
  // already rendered in the user's language. When Chrome's translator
  // mutates the DOM, React's reconciler crashes with "insertBefore on Node".
  useEffect(() => {
    localeRef.current = locale;
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  // Load translations for a given locale - memoized to avoid stale closures
  const loadTranslations = useCallback(async (targetLocale: Locale) => {
    try {
      const translations = await getTranslations(targetLocale);
      // Verify critical sections exist
      if (!translations || typeof translations !== 'object') {
        throw new Error(`Invalid translations object for locale ${targetLocale}`);
      }
      if (!translations.common || !translations.modes) {
        console.warn(`Missing sections in ${targetLocale}:`, {
          hasCommon: !!translations.common,
          hasModes: !!translations.modes,
          keys: Object.keys(translations).slice(0, 10),
        });
      }
      setMessages(translations);
      setLocale(targetLocale);
      localeRef.current = targetLocale;
    } catch (error) {
      console.error(`Failed to load translations for ${targetLocale}:`, error);
      // Fallback to default locale
      try {
        const defaultTranslations = await getTranslations(defaultLocale);
        setMessages(defaultTranslations);
        setLocale(defaultLocale);
        localeRef.current = defaultLocale;
      } catch (fallbackError) {
        console.error('Failed to load default locale translations:', fallbackError);
        // Last resort: empty translations object
        setMessages({});
        setLocale(defaultLocale);
        localeRef.current = defaultLocale;
      }
    }
  }, []);

  // Initial load - only user metadata can move the app away from English.
  useEffect(() => {
    let mounted = true;

    function initializeLocale() {
      const currentLocale = getUserLocale(user) ?? initialLocale;

      if (mounted) {
        setLocale(currentLocale);
        loadTranslations(currentLocale);
      }
    }

    initializeLocale();

    return () => {
      mounted = false;
    };
  }, [initialLocale, loadTranslations, user]);

  // Listen for locale change events from useLanguage hook
  useEffect(() => {
    const handleLocaleChange = (e: CustomEvent<Locale>) => {
      const newLocale = e.detail;
      // Use ref to check current locale to avoid stale closure
      if (newLocale !== localeRef.current && locales.includes(newLocale)) {
        loadTranslations(newLocale);
      }
    };

    window.addEventListener(LOCALE_CHANGE_EVENT as any, handleLocaleChange as EventListener);

    return () => {
      window.removeEventListener(LOCALE_CHANGE_EVENT as any, handleLocaleChange as EventListener);
    };
  }, [loadTranslations]);

  // Memoize messages to prevent unnecessary re-renders
  const safeMessages = useMemo(() => messages || defaultTranslations, [messages]);

  // Render immediately with the server-resolved catalog. English remains the fallback.
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={safeMessages as AbstractIntlMessages}
      timeZone="UTC"
    >
      {children}
    </NextIntlClientProvider>
  );
}
