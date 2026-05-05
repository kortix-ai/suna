import * as React from 'react';
import { Pressable, View, ScrollView } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Check } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const selectedBg = isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.06)';

  const handleLanguageSelect = async (languageCode: string) => {
    log.log('🌍 Language selected:', languageCode);
    haptics.selection();
    await setLanguage(languageCode);
  };

  return (
    <ScrollView
      className="flex-1 bg-background"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
    >
      <View className="pt-1 pb-8">
        <View className="px-6">
          <Text className="mb-2 text-[11px] font-roobert-medium uppercase tracking-wider text-muted-foreground/80">
            {t('language.selectLanguage')}
          </Text>
        </View>

        <View>
          {availableLanguages.map((language) => (
            <LanguageItem
              key={language.code}
              language={language}
              isSelected={currentLanguage === language.code}
              onPress={() => handleLanguageSelect(language.code)}
              selectedBg={selectedBg}
            />
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

interface LanguageItemProps {
  language: {
    code: string;
    name: string;
    nativeName: string;
  };
  isSelected: boolean;
  onPress: () => void;
  selectedBg: string;
}

function LanguageItem({ language, isSelected, onPress, selectedBg }: LanguageItemProps) {
  const flag = LANGUAGE_FLAGS[language.code] || '🌐';

  return (
    <Pressable
      onPress={onPress}
      className="active:opacity-85"
      style={{ backgroundColor: isSelected ? selectedBg : 'transparent' }}
    >
      <View className="px-6 py-3.5">
        <View className="flex-row items-center">
          <Text className="text-[22px]">{flag}</Text>

          <View className="ml-3.5 flex-1">
            <Text className="font-roobert-medium text-[15px] text-foreground mb-0.5">
              {language.nativeName}
            </Text>
            <Text className="font-roobert text-xs text-muted-foreground">{language.name}</Text>
          </View>

          {isSelected ? (
            <View className="ml-2 h-5 w-5 items-center justify-center rounded-full bg-foreground">
              <Icon as={Check} size={12} className="text-background" strokeWidth={2.7} />
            </View>
          ) : (
            <View className="h-5 w-5" />
          )}
        </View>
      </View>
    </Pressable>
  );
}
