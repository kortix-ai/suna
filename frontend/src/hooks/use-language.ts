'use client';

import { locales, defaultLocale, type Locale } from '@/i18n/config';
import { useCallback, useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { detectBestLocale } from '@/lib/utils/geo-detection';

/**
 * Gets the stored locale with priority:
 * 1. User profile preference (from user_metadata) - ALWAYS highest priority
 * 2. Cookie (explicit user preference)
 * 3. localStorage (explicit user preference)
 * 4. Geo-detection (timezone/browser) - default when nothing is explicitly set
 * 5. Default locale
 */
async function getStoredLocale(): Promise<Locale> {
  if (typeof window === 'undefined') return defaultLocale;

  try {
    // Priority 1: Check user profile preference (if authenticated)
    // This ALWAYS takes precedence - user explicitly set it in settings
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.user_metadata?.locale && locales.includes(user.user_metadata.locale as Locale)) {
      return user.user_metadata.locale as Locale;
    }
  } catch (error) {
    // Silently fail - user might not be authenticated
  }
  
  // Priority 2: Check cookie (explicit user preference)
  const cookies = document.cookie.split(';');
  const localeCookie = cookies.find(c => c.trim().startsWith('locale='));
  if (localeCookie) {
    const value = localeCookie.split('=')[1].trim();
    if (locales.includes(value as Locale)) {
      return value as Locale;
    }
  }
  
  // Priority 3: Check localStorage (explicit user preference)
  const stored = localStorage.getItem('locale');
  if (stored && locales.includes(stored as Locale)) {
    return stored as Locale;
  }
  
  // Priority 4: Geo-detection (default when nothing is explicitly set)
  const geoDetected = detectBestLocale();
  return geoDetected;
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
      // Priority 1: Save to user profile if authenticated (highest priority)
      // This is the explicit user preference from settings
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      
      if (user) {
        try {
          const { error: updateError } = await supabase.auth.updateUser({
            data: { locale: newLocale }
          });
          
          if (updateError) {
            console.warn('Failed to save locale to user profile:', updateError);
          }
        } catch (error) {
          console.warn('Error saving locale to user profile:', error);
        }
      }
    } catch (error) {
      // User might not be authenticated, continue with cookie/localStorage
    }
    
    // Priority 2: Store preference in cookie (explicit user preference)
    const cookieValue = `locale=${newLocale}; path=/; max-age=31536000; SameSite=Lax`;
    document.cookie = cookieValue;
    
    // Priority 3: Store in localStorage as backup (explicit user preference)
    if (typeof window !== 'undefined') {
      localStorage.setItem('locale', newLocale);
    }

    // Update local state immediately
    setLocale(newLocale);
    
    // Dispatch custom event to notify I18nProvider and other components
    const event = new CustomEvent(LOCALE_CHANGE_EVENT, { detail: newLocale });
    window.dispatchEvent(event);
    
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

