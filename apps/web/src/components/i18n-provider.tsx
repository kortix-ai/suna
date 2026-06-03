'use client';

import { NextIntlClientProvider } from 'next-intl';
import { ReactNode, useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { locales, defaultLocale, type Locale } from '@/i18n/config';
import {
  getBrowserLocale,
  hasExplicitBrowserLocalePreference,
  LOCALE_CHANGE_EVENT,
  persistBrowserLocale,
} from '@/i18n/locale';
import { detectBestLocale } from '@/lib/utils/geo-detection';
import { useAuth } from '@/components/AuthProvider';

// Preload default translations synchronously for immediate render
// This prevents the loading spinner from blocking FCP
import defaultTranslations from '../../translations/en.json';

async function getTranslations(locale: Locale) {
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

export function I18nProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  // Initialize with preloaded English translations to prevent blocking FCP
  const [messages, setMessages] = useState<any>(defaultTranslations);
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
      if (!translations.common) {
        console.warn(`Missing sections in ${targetLocale}:`, {
          hasCommon: !!translations.common,
          keys: Object.keys(translations).slice(0, 10)
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

  // Initial load - check user metadata, then cookie/localStorage, then geo-detect
  useEffect(() => {
    let mounted = true;
    
    function initializeLocale() {
      const currentLocale = getBrowserLocale(user, detectBestLocale);
      
      if (!mounted) return;
      
      // Only auto-save geo-detected locale if:
      // 1. User has NO explicit preference (no metadata, cookie, or localStorage)
      // 2. Geo-detected locale is different from default
      // 3. User is NOT authenticated OR authenticated but has no locale in metadata
      if (!hasExplicitBrowserLocalePreference(user) && currentLocale !== defaultLocale) {
        persistBrowserLocale(currentLocale);
      }
      
      if (mounted) {
        setLocale(currentLocale);
        loadTranslations(currentLocale);
      }
    }
    
    initializeLocale();
    
    return () => {
      mounted = false;
    };
  }, [loadTranslations, user]);

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

  // Listen for storage changes (when language is changed in another tab/window)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'locale' && e.newValue && locales.includes(e.newValue as Locale)) {
        loadTranslations(e.newValue as Locale);
      }
    };

    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [loadTranslations]);

  // Memoize messages to prevent unnecessary re-renders
  const safeMessages = useMemo(() => messages || defaultTranslations, [messages]);

  // Always render children immediately with available translations
  // This prevents blocking FCP - we start with English and swap if needed
  return (
    <NextIntlClientProvider 
      locale={locale} 
      messages={safeMessages} 
      timeZone="UTC"
    >
      {children}
    </NextIntlClientProvider>
  );
}
