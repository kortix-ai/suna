import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEFAULT_LOCALE,
  LANGUAGE_PICKER_ENABLED,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from './locale-config';
import { loadLocaleBundle, resolveUiLocale } from './boot-locale';
import { supabase } from '@/api/supabase';
import { log } from '@/lib/logger';

const LANGUAGE_KEY = '@kortix_language';

/**
 * i18n initialises synchronously at import, in English, from the bundled
 * resources, so the first frame never waits on storage or the network.
 * Other locales load on demand (`ensureLocaleBundle`).
 *
 * Priority (matching web):
 * 1. User profile preference, applied once auth restores (`applyProfileLocale`)
 * 2. Default English
 *
 * While `LANGUAGE_PICKER_ENABLED` is false, step 1 is skipped: the UI stays in
 * English and `changeLanguage` is a no-op.
 *
 * Device locale, timezone, and saved local values never change language on boot.
 * AsyncStorage is only a cross-screen signal after the settings flow writes the
 * profile preference successfully.
 */
void i18n.use(initReactI18next).init({
  resources: { [DEFAULT_LOCALE]: { translation: loadLocaleBundle(DEFAULT_LOCALE) } },
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  compatibilityJSON: 'v4',
  initAsync: false,
  interpolation: {
    escapeValue: false, // React already escapes values
  },
  react: {
    useSuspense: false, // Important for React Native
  },
});

function ensureLocaleBundle(locale: SupportedLocale): void {
  if (i18n.hasResourceBundle(locale, 'translation')) return;
  i18n.addResourceBundle(locale, 'translation', loadLocaleBundle(locale));
}

/**
 * Switch to the signed-in user's profile locale. Reads the restored session's
 * user object, so it makes no network call. A user without a profile locale
 * keeps the current language.
 */
export const applyProfileLocale = async (
  user: { user_metadata?: { locale?: unknown } } | null | undefined
) => {
  if (!user) return;
  // Picker off: English whatever the profile says (see LANGUAGE_PICKER_ENABLED).
  const locale = resolveUiLocale(user, LANGUAGE_PICKER_ENABLED);
  if (locale === i18n.language) return;
  // resolveBootLocale falls back to English; only a valid profile value switches.
  if (LANGUAGE_PICKER_ENABLED && locale !== user.user_metadata?.locale) return;
  try {
    ensureLocaleBundle(locale);
    await i18n.changeLanguage(locale);
    if (LANGUAGE_PICKER_ENABLED) await AsyncStorage.setItem(LANGUAGE_KEY, locale);
    log.log(`✅ Using user metadata locale: ${locale}`);
  } catch (error) {
    log.warn('⚠️ Could not apply profile locale:', error);
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

    if (!LANGUAGE_PICKER_ENABLED) {
      log.warn('⚠️ Language picker is disabled; the UI stays in English');
      return;
    }

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
    ensureLocaleBundle(languageCode as SupportedLocale);
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
