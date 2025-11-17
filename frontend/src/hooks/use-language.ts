'use client';

import { locales, defaultLocale, type Locale } from '@/i18n/config';
import { useCallback, useState, useEffect } from 'react';

function getStoredLocale(): Locale {
  if (typeof window === 'undefined') return defaultLocale;

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

  return defaultLocale;
}

// Custom event name for locale changes
const LOCALE_CHANGE_EVENT = 'locale-change';

export function useLanguage() {
  const [locale, setLocale] = useState<Locale>(() => {
    if (typeof window !== 'undefined') {
      return getStoredLocale();
    }
    return defaultLocale;
  });
  const [isChanging, setIsChanging] = useState(false);

  // Listen for locale changes from other components
  useEffect(() => {
    const handleLocaleChange = (e: CustomEvent<Locale>) => {
      const newLocale = e.detail;
      if (newLocale !== locale) {
        setLocale(newLocale);
        setIsChanging(false);
      }
    };

    window.addEventListener(LOCALE_CHANGE_EVENT as any, handleLocaleChange as EventListener);
    
    return () => {
      window.removeEventListener(LOCALE_CHANGE_EVENT as any, handleLocaleChange as EventListener);
    };
  }, [locale]);

  // Detect locale from cookie or localStorage on mount
  useEffect(() => {
    const storedLocale = getStoredLocale();
    if (storedLocale !== locale) {
      setLocale(storedLocale);
    }
  }, []);

  const setLanguage = useCallback(async (newLocale: Locale) => {
    if (newLocale === locale) return;
    
    setIsChanging(true);
    
    // Store preference in cookie with proper encoding
    const cookieValue = `locale=${newLocale}; path=/; max-age=31536000; SameSite=Lax`;
    document.cookie = cookieValue;
    console.log(`🍪 Setting locale cookie: ${cookieValue}`);
    
    // Store in localStorage as backup
    if (typeof window !== 'undefined') {
      localStorage.setItem('locale', newLocale);
      console.log(`💾 Setting locale in localStorage: ${newLocale}`);
    }

    // Update local state immediately
    setLocale(newLocale);
    
    // Dispatch custom event to notify I18nProvider and other components
    const event = new CustomEvent(LOCALE_CHANGE_EVENT, { detail: newLocale });
    window.dispatchEvent(event);
    
    console.log(`🌍 Language changed to: ${newLocale}`);
    
    // Reset changing state after a brief delay
    setTimeout(() => {
      setIsChanging(false);
    }, 100);
  }, [locale]);

  return {
    locale,
    setLanguage,
    availableLanguages: locales,
    isChanging
  };
}

