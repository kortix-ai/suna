'use client';

import { useAuth } from '@/features/providers/auth-provider';
import { defaultLocale, locales, type Locale } from '@/i18n/config';
import { getExplicitLocale, LOCALE_CHANGE_EVENT } from '@/i18n/locale';
import { createClient } from '@/lib/supabase/client';
import { useCallback, useEffect, useState } from 'react';

export function useLanguage() {
  // Use AuthProvider's user to avoid unnecessary getUser calls
  const { user } = useAuth();
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  const [isChanging, setIsChanging] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Load locale on mount. Only profile metadata can switch away from English.
  useEffect(() => {
    let mounted = true;

    const storedLocale = getExplicitLocale(user);
    if (mounted) {
      setLocale(storedLocale);
      setIsLoading(false);
    }

    return () => {
      mounted = false;
    };
  }, [user]);

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

  const setLanguage = useCallback(
    async (newLocale: Locale) => {
      if (newLocale === locale) return;

      setIsChanging(true);

      if (!user) {
        setLocale(defaultLocale);
        setIsChanging(false);
        return;
      }

      try {
        const supabase = createClient();
        const { error: updateError } = await supabase.auth.updateUser({
          data: { locale: newLocale },
        });

        if (updateError) {
          console.warn('Failed to save locale to user profile:', updateError);
          setIsChanging(false);
          return;
        }
      } catch (error) {
        console.warn('Error saving locale to user profile:', error);
        setIsChanging(false);
        return;
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
    },
    [locale, user],
  );

  return {
    locale,
    setLanguage,
    availableLanguages: locales,
    isChanging,
    isLoading,
  };
}
