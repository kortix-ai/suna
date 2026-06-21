import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from './locale-config';
import { supabase } from '@/api/supabase';

// Import translations
import en from '@/locales/en.json';
import es from '@/locales/es.json';
import fr from '@/locales/fr.json';
import de from '@/locales/de.json';
import it from '@/locales/it.json';
import pt from '@/locales/pt.json';
import zh from '@/locales/zh.json';
import ja from '@/locales/ja.json';
import { log } from '@/lib/logger';

const LANGUAGE_KEY = '@kortix_language';

// Language resources
const resources = {
  en: { translation: en },
  es: { translation: es },
  fr: { translation: fr },
  de: { translation: de },
  it: { translation: it },
  pt: { translation: pt },
  zh: { translation: zh },
  ja: { translation: ja },
};

/**
 * Initialize i18n.
 * Priority (matching web):
 * 1. User profile preference (if authenticated)
 * 2. Default English
 *
 * Device locale, timezone, and saved local values never change language on boot.
 * AsyncStorage is only a cross-screen signal after the settings flow writes the
 * profile preference successfully.
 */
export const initializeI18n = async () => {
  try {
    let initialLanguage: SupportedLocale = DEFAULT_LOCALE;

    // Check user profile preference (if authenticated).
    // This is the only persisted source that can switch away from English.
    // NOTE: supabase.auth.getUser() hits the network to validate the JWT and
    // can hang indefinitely when offline. Since this runs on the critical boot
    // path (the app renders nothing until i18n is ready), we race it against a
    // short timeout so a missing connection can never block startup. Without a
    // profile locale, startup falls back to English.
    try {
      const {
        data: { user },
      } = await Promise.race([
        supabase.auth.getUser(),
        new Promise<{ data: { user: null } }>((resolve) =>
          setTimeout(() => resolve({ data: { user: null } }), 2500)
        ),
      ]);
      if (
        user?.user_metadata?.locale &&
        SUPPORTED_LOCALES.includes(user.user_metadata.locale as SupportedLocale)
      ) {
        initialLanguage = user.user_metadata.locale as SupportedLocale;
        log.log(`✅ Using user metadata locale: ${initialLanguage}`);

        // Save to AsyncStorage as an explicit settings signal for the running app.
        await AsyncStorage.setItem(LANGUAGE_KEY, initialLanguage);

        // Initialize i18n with user's profile locale
        await i18n.use(initReactI18next).init({
          resources,
          lng: initialLanguage,
          fallbackLng: DEFAULT_LOCALE,
          compatibilityJSON: 'v4',
          interpolation: {
            escapeValue: false,
          },
          react: {
            useSuspense: false,
          },
        });

        log.log('✅ i18n initialized with user profile locale:', i18n.language);
        return;
      }
    } catch (error) {
      // User might not be authenticated, continue with English.
      log.debug('Could not fetch user locale from profile:', error);
    }

    await i18n.use(initReactI18next).init({
      resources,
      lng: initialLanguage,
      fallbackLng: DEFAULT_LOCALE,
      compatibilityJSON: 'v4',
      interpolation: {
        escapeValue: false, // React already escapes values
      },
      react: {
        useSuspense: false, // Important for React Native
      },
    });

    log.log('✅ i18n initialized with language:', i18n.language);
  } catch (error) {
    log.error('❌ i18n initialization error:', error);
    // Fallback to default locale on error
    await i18n.use(initReactI18next).init({
      resources,
      lng: DEFAULT_LOCALE,
      fallbackLng: DEFAULT_LOCALE,
      compatibilityJSON: 'v4',
      interpolation: {
        escapeValue: false,
      },
      react: {
        useSuspense: false,
      },
    });
  }
};

/**
 * Change language and persist to AsyncStorage and user profile
 * Updates user_metadata.locale if user is authenticated (matching web behavior).
 * The UI only changes after that profile update succeeds.
 */
export const changeLanguage = async (languageCode: string) => {
  try {
    log.log('🌍 Changing language to:', languageCode);

    // Validate language code
    if (!SUPPORTED_LOCALES.includes(languageCode as SupportedLocale)) {
      log.warn(`⚠️ Invalid language code: ${languageCode}`);
      return;
    }

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        log.warn('⚠️ Cannot change language without an authenticated user profile');
        return;
      }

      const { error } = await supabase.auth.updateUser({
        data: { locale: languageCode },
      });

      if (error) {
        log.warn('⚠️ Could not update user profile locale:', error);
        return;
      }

      log.log('✅ Language updated in user profile:', languageCode);
    } catch (error) {
      log.debug('Could not update user profile locale:', error);
      return;
    }

    // Update i18n only after the profile preference has been saved.
    await i18n.changeLanguage(languageCode);
    await AsyncStorage.setItem(LANGUAGE_KEY, languageCode);

    log.log('✅ Language changed and saved:', languageCode);
  } catch (error) {
    log.error('❌ Language change error:', error);
  }
};

/**
 * Get current language
 */
export const getCurrentLanguage = () => {
  return i18n.language;
};

/**
 * Get all available languages
 */
export const getAvailableLanguages = () => {
  return [
    { code: 'en', name: 'English', nativeName: 'English' },
    { code: 'es', name: 'Spanish', nativeName: 'Español' },
    { code: 'fr', name: 'French', nativeName: 'Français' },
    { code: 'de', name: 'German', nativeName: 'Deutsch' },
    { code: 'it', name: 'Italian', nativeName: 'Italiano' },
    { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
    { code: 'zh', name: 'Chinese', nativeName: '中文' },
    { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  ];
};

export default i18n;
