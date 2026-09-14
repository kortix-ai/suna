import * as React from 'react';

import { Text } from '@/components/ui/text';
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { useLanguage } from '@/contexts';
import { haptics } from '@/lib/haptics';
import { log } from '@/lib/logger';

const LANGUAGE_FLAGS: Record<string, string> = {
  en: '🇺🇸',
  es: '🇪🇸',
  fr: '🇫🇷',
  de: '🇩🇪',
  it: '🇮🇹',
  pt: '🇧🇷',
  zh: '🇨🇳',
  ja: '🇯🇵',
};

export default function LanguageScreen() {
  const { currentLanguage, availableLanguages, setLanguage, t } = useLanguage();

  const handleLanguageSelect = async (languageCode: string) => {
    if (languageCode === currentLanguage) return;
    log.log('🌍 Language selected:', languageCode);
    haptics.selection();
    await setLanguage(languageCode);
  };

  return (
    <SettingsPage>
      <SettingsGroup title={t('language.selectLanguage')}>
        {availableLanguages.map((language) => (
          <SettingsRow
            key={language.code}
            leading={<Text variant="large">{LANGUAGE_FLAGS[language.code] || '🌐'}</Text>}
            label={language.nativeName}
            // English name only when it differs ("Español" → "Spanish").
            value={language.name !== language.nativeName ? language.name : undefined}
            checked={currentLanguage === language.code}
            right={null}
            onPress={() => void handleLanguageSelect(language.code)}
          />
        ))}
      </SettingsGroup>
    </SettingsPage>
  );
}
