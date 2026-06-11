import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { detectBestLocale, DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from './geo-detection';
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
 * Initialize i18n with AsyncStorage persistence and geo-detection
 * Priority (matching web frontend):
 * 1. User profile preference (if authenticated) - HIGHEST PRIORITY
 * 2. Saved AsyncStorage preference
 * 3. Geo-detection (device locale + timezone)
 * 4. Default (English)
 */
export const initializeI18n = async () => {
  try {
    let initialLanguage: SupportedLocale = DEFAULT_LOCALE;

    // Priority 1: Check user profile preference (if authenticated)
    // This ALWAYS takes precedence - user explicitly set it in settings.
    // NOTE: supabase.auth.getUser() hits the network to validate the JWT and
    // can hang indefinitely when offline. Since this runs on the critical boot
    // path (the app renders nothing until i18n is ready), we race it against a
    // short timeout so a missing connection can never block startup — we just
    // fall back to the locally-saved language preference below.
    try {
      const { data: { user } } = await Promise.race([
        supabase.auth.getUser(),
        new Promise<{ data: { user: null } }>((resolve) =>
          setTimeout(() => resolve({ data: { user: null } }), 2500),
        ),
      ]);
      if (user?.user_metadata?.locale && SUPPORTED_LOCALES.includes(user.user_metadata.locale as SupportedLocale)) {
        initialLanguage = user.user_metadata.locale as SupportedLocale;
        log.log(`✅ Using user metadata locale (highest priority): ${initialLanguage}`);
        
        // Save to AsyncStorage for consistency
        await AsyncStorage.setItem(LANGUAGE_KEY, initialLanguage);
        
        // Initialize i18n with user's profile locale
        await i18n
          .use(initReactI18next)
          .init({
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
      // User might not be authenticated, continue with other methods
      log.debug('Could not fetch user locale from profile:', error);
    }

    // Priority 2: Get saved language from AsyncStorage (user's explicit preference)
    const savedLanguage = await AsyncStorage.getItem(LANGUAGE_KEY);
    log.log('🌍 Saved language preference:', savedLanguage);
    
    if (savedLanguage && SUPPORTED_LOCALES.includes(savedLanguage as SupportedLocale)) {
      initialLanguage = savedLanguage as SupportedLocale;
      log.log('✅ Using saved language preference:', initialLanguage);
    } else {
      // Priority 3: Geo-detect based on device settings and timezone
      const detectedLocale = detectBestLocale();
      initialLanguage = detectedLocale;
      log.log('✅ Using geo-detected locale:', initialLanguage);
      
      // Save the detected locale so we don't detect again
      // User can still change it manually in settings
      await AsyncStorage.setItem(LANGUAGE_KEY, initialLanguage);
    }

    await i18n
      .use(initReactI18next)
      .init({
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
    await i18n
      .use(initReactI18next)
      .init({
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
 * Updates user_metadata.locale if user is authenticated (matching web behavior)
 */
export const changeLanguage = async (languageCode: string) => {
  try {
    log.log('🌍 Changing language to:', languageCode);
    
    // Validate language code
    if (!SUPPORTED_LOCALES.includes(languageCode as SupportedLocale)) {
      log.warn(`⚠️ Invalid language code: ${languageCode}, using default`);
      languageCode = DEFAULT_LOCALE;
    }
    
    // Update i18n
    await i18n.changeLanguage(languageCode);
    
    // Save to AsyncStorage
    await AsyncStorage.setItem(LANGUAGE_KEY, languageCode);
    
    // Update user profile metadata if authenticated (matching web behavior)
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { error } = await supabase.auth.updateUser({
          data: { locale: languageCode }
        });
        
        if (error) {
          log.warn('⚠️ Could not update user profile locale:', error);
        } else {
          log.log('✅ Language updated in user profile:', languageCode);
        }
      }
    } catch (error) {
      // User might not be authenticated, that's okay
      log.debug('Could not update user profile locale (user not authenticated):', error);
    }
    
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

