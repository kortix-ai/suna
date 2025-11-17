'use client';

import { locales, defaultLocale, type Locale } from '@/i18n/config';
import { useCallback, useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { detectBestLocale } from '@/lib/utils/geo-detection';

/**
 * Gets the stored locale with priority:
 * 1. User profile preference (from user_metadata)
 * 2. Cookie
 * 3. localStorage
 * 4. Geo-detection (timezone/browser)
 * 5. Default
 */
async function getStoredLocale(): Promise<Locale> {
  if (typeof window === 'undefined') return defaultLocale;

  try {
    // Check user profile preference (if authenticated)
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.user_metadata?.locale && locales.includes(user.user_metadata.locale as Locale)) {
      return user.user_metadata.locale as Locale;
    }
  } catch (error) {
    // Silently fail - user might not be authenticated
    console.debug('Could not fetch user locale:', error);
  }

  // Check cookie
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

  // Geo-detection fallback
  return detectBestLocale();
}

// Custom event name for locale changes
const LOCALE_CHANGE_EVENT = 'locale-change';

export function useLanguage() {
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  const [isChanging, setIsChanging] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Load locale on mount (async)
  useEffect(() => {
    let mounted = true;
    
    getStoredLocale().then((storedLocale) => {
      if (mounted) {
        setLocale(storedLocale);
        setIsLoading(false);
      }
    });

    return () => {
      mounted = false;
    };
  }, []);

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

  const setLanguage = useCallback(async (newLocale: Locale) => {
    if (newLocale === locale) return;
    
    setIsChanging(true);
    
    try {
      // Save to user profile if authenticated (highest priority)
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      
      if (user) {
        try {
          const { error: updateError } = await supabase.auth.updateUser({
            data: { locale: newLocale }
          });
          
          if (updateError) {
            console.warn('Failed to save locale to user profile:', updateError);
          } else {
            console.log(`💾 Saved locale to user profile: ${newLocale}`);
          }
        } catch (error) {
          console.warn('Error saving locale to user profile:', error);
        }
      }
    } catch (error) {
      // User might not be authenticated, continue with cookie/localStorage
      console.debug('User not authenticated, skipping profile save:', error);
    }
    
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
    isChanging,
    isLoading
  };
}

