import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage, getCurrentLanguage, getAvailableLanguages } from '@/lib/utils/i18n';
import { log } from '@/lib/logger';

interface Language {
  code: string;
  name: string;
  nativeName: string;
}

interface LanguageContextValue {
  currentLanguage: string;
  availableLanguages: Language[];
  setLanguage: (languageCode: string) => Promise<void>;
  t: (key: string, options?: any) => string;
}

const LanguageContext = React.createContext<LanguageContextValue | undefined>(undefined);

/**
 * LanguageProvider Component
 * 
 * Provides language context to the entire app.
 * Wraps i18next functionality with React context for easier access.
 * Listens to i18n language changes for immediate UI updates.
 */
export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const { t, i18n: i18nInstance } = useTranslation();
  // Use i18n.language directly and listen to changes for immediate updates
  const [currentLanguage, setCurrentLanguage] = React.useState(i18nInstance.language || getCurrentLanguage());

  // Listen to i18n language changes for immediate UI updates
  React.useEffect(() => {
    const handleLanguageChanged = (lng: string) => {
      log.log('🌍 LanguageContext: Language changed event received:', lng);
      setCurrentLanguage(lng);
    };

    // Subscribe to language change events
    i18nInstance.on('languageChanged', handleLanguageChanged);

    // Also update immediately if language is already set
    if (i18nInstance.language && i18nInstance.language !== currentLanguage) {
      setCurrentLanguage(i18nInstance.language);
    }

    return () => {
      i18nInstance.off('languageChanged', handleLanguageChanged);
    };
  }, [i18nInstance, currentLanguage]);

  const handleSetLanguage = React.useCallback(async (languageCode: string) => {
    log.log('🌍 LanguageContext: Setting language to', languageCode);
    await changeLanguage(languageCode);
    // The languageChanged event will update currentLanguage automatically
    log.log('✅ LanguageContext: Language change initiated:', languageCode);
  }, []);

  const value = React.useMemo(
    () => ({
      currentLanguage,
      availableLanguages: getAvailableLanguages(),
      setLanguage: handleSetLanguage,
      t,
    }),
    [currentLanguage, handleSetLanguage, t]
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

/**
 * Hook to access language context
 */
export function useLanguage() {
  const context = React.useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}

