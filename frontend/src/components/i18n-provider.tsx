'use client';

import { NextIntlClientProvider } from 'next-intl';
import { ReactNode, useEffect, useState, useCallback, useRef } from 'react';
import { locales, defaultLocale, type Locale } from '@/i18n/config';

async function getMessages(locale: Locale) {
  try {
    return (await import(`../../translations/${locale}.json`)).default;
  } catch (error) {
    console.error(`Failed to load messages for locale ${locale}:`, error);
    // Fallback to English if locale file doesn't exist
    return (await import(`../../translations/${defaultLocale}.json`)).default;
  }
}

function getStoredLocale(): Locale {
  if (typeof window === 'undefined') return defaultLocale;
  
  try {
    // Check cookie first
    const cookies = document.cookie.split(';');
    const localeCookie = cookies.find(c => c.trim().startsWith('locale='));
    if (localeCookie) {
      const value = localeCookie.split('=')[1].trim();
      if (locales.includes(value as Locale)) {
        return value as Locale;
      }
    }
    
    // Check localStorage
    const stored = localStorage.getItem('locale');
    if (stored && locales.includes(stored as Locale)) {
      return stored as Locale;
    }
    
    // Check browser language
    const browserLang = navigator.language.split('-')[0].toLowerCase();
    if (locales.includes(browserLang as Locale)) {
      return browserLang as Locale;
    }
  } catch (error) {
    console.error('Error getting stored locale:', error);
  }
  
  return defaultLocale;
}

// Custom event name for locale changes (must match use-language.ts)
const LOCALE_CHANGE_EVENT = 'locale-change';

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => {
    // Initialize from stored locale immediately
    if (typeof window !== 'undefined') {
      return getStoredLocale();
    }
    return defaultLocale;
  });
  const [messages, setMessages] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const localeRef = useRef(locale);

  // Update ref when locale changes
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);

  // Load messages for a given locale - memoized to avoid stale closures
  const loadMessages = useCallback(async (targetLocale: Locale) => {
    setIsLoading(true);
    try {
      const msgs = await getMessages(targetLocale);
      // Verify critical sections exist
      if (!msgs || typeof msgs !== 'object') {
        throw new Error(`Invalid messages object for locale ${targetLocale}`);
      }
      if (!msgs.common || !msgs.suna) {
        console.warn(`⚠️ Missing sections in ${targetLocale}:`, {
          hasCommon: !!msgs.common,
          hasSuna: !!msgs.suna,
          keys: Object.keys(msgs).slice(0, 10)
        });
      }
      setMessages(msgs);
      setLocale(targetLocale);
      localeRef.current = targetLocale;
      console.log(`✅ Loaded translations for locale: ${targetLocale}`, {
        keys: Object.keys(msgs).length,
        hasCommon: !!msgs.common,
        hasSuna: !!msgs.suna
      });
    } catch (error) {
      console.error(`❌ Failed to load messages for ${targetLocale}:`, error);
      // Fallback to default locale
      try {
        const defaultMsgs = await getMessages(defaultLocale);
        setMessages(defaultMsgs);
        setLocale(defaultLocale);
        localeRef.current = defaultLocale;
        console.log(`✅ Fallback to default locale: ${defaultLocale}`);
      } catch (fallbackError) {
        console.error('❌ Failed to load default locale messages:', fallbackError);
        // Last resort: empty messages object
        setMessages({});
        setLocale(defaultLocale);
        localeRef.current = defaultLocale;
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    const currentLocale = getStoredLocale();
    loadMessages(currentLocale);
  }, [loadMessages]);

  // Listen for locale change events from useLanguage hook
  useEffect(() => {
    const handleLocaleChange = (e: CustomEvent<Locale>) => {
      const newLocale = e.detail;
      console.log(`🔄 Locale change event received: ${newLocale}`);
      // Use ref to check current locale to avoid stale closure
      if (newLocale !== localeRef.current && locales.includes(newLocale)) {
        loadMessages(newLocale);
      }
    };

    window.addEventListener(LOCALE_CHANGE_EVENT as any, handleLocaleChange as EventListener);

    return () => {
      window.removeEventListener(LOCALE_CHANGE_EVENT as any, handleLocaleChange as EventListener);
    };
  }, [loadMessages]);

  // Listen for storage changes (when language is changed in another tab/window)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'locale' && e.newValue && locales.includes(e.newValue as Locale)) {
        console.log(`🔄 Storage change detected, loading locale: ${e.newValue}`);
        loadMessages(e.newValue as Locale);
      }
    };

    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [loadMessages]);

  // Always wrap with NextIntlClientProvider, even if messages are null
  // This ensures the context is always available
  // Use empty object as fallback to prevent errors
  const safeMessages = messages || {};

  if (messages) {
    console.log(`🌍 I18nProvider: Providing locale "${locale}" with ${Object.keys(messages).length} translation keys`, {
      hasCommon: !!messages.common,
      hasSuna: !!messages.suna,
      commonKeys: messages.common ? Object.keys(messages.common).length : 0,
      sunaKeys: messages.suna ? Object.keys(messages.suna).length : 0
    });
  } else {
    console.log('⏳ I18nProvider: Loading messages, using empty fallback...');
  }

  // Don't render children until messages are loaded to prevent MISSING_MESSAGE errors
  if (!messages || Object.keys(messages).length === 0) {
    return (
      <NextIntlClientProvider locale={defaultLocale} messages={{}}>
        <div className="min-h-screen flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
        </div>
      </NextIntlClientProvider>
    );
  }

  return (
    <NextIntlClientProvider locale={locale} messages={safeMessages} key={locale}>
      {children}
    </NextIntlClientProvider>
  );
}

