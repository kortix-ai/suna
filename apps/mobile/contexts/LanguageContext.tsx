import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage, getCurrentLanguage, getAvailableLanguages } from '@/lib/utils/i18n';

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
 */
export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const { t, i18n } = useTranslation();
  const [currentLanguage, setCurrentLanguage] = React.useState(getCurrentLanguage());

  const handleSetLanguage = React.useCallback(async (languageCode: string) => {
    console.log('🌍 LanguageContext: Setting language to', languageCode);
    await changeLanguage(languageCode);
    setCurrentLanguage(languageCode);
    console.log('✅ LanguageContext: Language set to', languageCode);
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

