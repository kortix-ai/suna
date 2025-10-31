import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Import translations
import en from '@/locales/en.json';
import es from '@/locales/es.json';
import fr from '@/locales/fr.json';
import de from '@/locales/de.json';
import it from '@/locales/it.json';
import pt from '@/locales/pt.json';
import zh from '@/locales/zh.json';
import ja from '@/locales/ja.json';

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
 * Initialize i18n with AsyncStorage persistence
 */
export const initializeI18n = async () => {
  try {
    // Get saved language from AsyncStorage
    const savedLanguage = await AsyncStorage.getItem(LANGUAGE_KEY);
    console.log('🌍 Saved language:', savedLanguage);

    await i18n
      .use(initReactI18next)
      .init({
        resources,
        lng: savedLanguage || 'en', // Default to English if no saved language
        fallbackLng: 'en',
        compatibilityJSON: 'v4',
        interpolation: {
          escapeValue: false, // React already escapes values
        },
        react: {
          useSuspense: false, // Important for React Native
        },
      });

    console.log('✅ i18n initialized with language:', i18n.language);
  } catch (error) {
    console.error('❌ i18n initialization error:', error);
  }
};

/**
 * Change language and persist to AsyncStorage
 */
export const changeLanguage = async (languageCode: string) => {
  try {
    console.log('🌍 Changing language to:', languageCode);
    await i18n.changeLanguage(languageCode);
    await AsyncStorage.setItem(LANGUAGE_KEY, languageCode);
    console.log('✅ Language changed and saved:', languageCode);
  } catch (error) {
    console.error('❌ Language change error:', error);
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

